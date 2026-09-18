import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { DiffEditor, type MonacoDiffEditor, type OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { api } from '../api';
import {
  parseConflictBlocks,
  resolvedBlockLines,
  splitLines,
  type ConflictBlock,
  type ConflictResolveKind,
} from '../conflictBlocks';
import { useT, type StringKey } from '../i18n';
import { languageFor } from '../monaco-setup';
import { monacoThemeName } from '../theme/monacoTheme';
import { useTheme } from '../theme/themeStore';
import type { ConflictSide, DiffPair, FileContent } from '../types';
import { useConfirm } from './ConfirmDialog';

/**
 * 競合ファイル (StatusFile.conflicted) を開いて解決するペイン。DiffTabsPane の
 * タブとして DiffPane と並んでホストされる (kind: 'conflict')。
 *
 * VS Code のマージエディターと同じ 3 画面構成:
 *   上段左 Current (ours)   … base(:1) → ours(:2)   の差分 (読み取り専用)
 *   上段右 Incoming (theirs) … base(:1) → theirs(:3) の差分 (読み取り専用)
 *   下段   Result           … 作業ツリーの実ファイル (競合マーカー入り・編集可)
 *
 * - 内容の読み書きは FilesTab と同じ encoding 対応の api.file / api.saveFile を再利用する
 *   (SJIS 等の非 UTF-8 競合ファイルも正しく読める)。
 * - Monaco は FilesTab と同じ「uncontrolled」運用: defaultValue は初回のみ、以降は
 *   onChange で draft state に一方向反映するだけで、value prop での書き戻しはしない。
 * - モデル URI は `${leafId}-conflict/` prefix で名前空間を切り、他タブ (FilesTab / 別の
 *   ConflictResolvePane) の同名パスモデルと衝突しないようにする (詳細は modelPath のコメント)。
 */

const EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  fontSize: 13,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  automaticLayout: true,
  renderWhitespace: 'selection',
};

// 上段 2 ペインは横幅が半分しかないので **inline (unified) 差分**にする。
//
// hideUnchangedRegions は **立てない**: 実ファイル (1331 行・競合ブロック 1 個で 682 行) で
// 測ると Incoming 側が丸ごと「293 hidden lines」に畳まれ、コードが 1 行も見えなかった。
// 競合解決では変更行そのものより **前後の文脈** が判断材料なので、畳むと用を成さない。
// renderOverviewRuler は立てる: 長いファイルでは変更箇所がスクロールバー側に出ないと、
// どこに差分があるか当てずっぽうでスクロールすることになる。
const SIDE_DIFF_OPTIONS: monaco.editor.IDiffEditorConstructionOptions = {
  readOnly: true,
  renderSideBySide: false,
  // 結果ペイン (EDITOR_OPTIONS) と**同じ文字サイズ**にする。ここだけ小さくすると行高が
  // 変わり、px でのスクロール同期が 3 ペインで行としてズレる (実測で踏んだ)。
  fontSize: 13,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  automaticLayout: true,
  renderOverviewRuler: true,
  hideUnchangedRegions: { enabled: false },
};

const SIDE_LABEL_KEYS: Record<ConflictSide, StringKey> = {
  ours: 'conflict.sideOurs',
  theirs: 'conflict.sideTheirs',
};

/** 上段の既定の高さ (%)。0 まで畳めば実質 1 画面、85 が上限。 */
const DEFAULT_TOP_PCT = 45;
const MAX_TOP_PCT = 85;

function disposeModelSoon(uriPath: string) {
  setTimeout(() => monaco.editor.getModel(monaco.Uri.parse(uriPath))?.dispose(), 0);
}

// ---- 結果ペインの CodeLens (「Current を取り込む | Incoming を取り込む | 両方」) ----
//
// monaco.languages.registerCodeLensProvider は **言語セレクター単位のグローバル登録**で、
// '*' で登録すると FilesTab の通常エディターにも発火してしまう。そこで provider は
// モジュールスコープで 1 回だけ張り、下のレジストリーに載っているモデル URI にだけ
// lens を返す。登録されるのは `${leafId}-conflict/...` 名前空間の URI だけなので、
// 競合タブ以外には lens が一切出ない (この漏れが今回いちばん壊しやすいので検証必須)。
interface LensEntry {
  blocks: ConflictBlock[];
  labels: Record<ConflictResolveKind, string>;
  apply: (blockIndex: number, kind: ConflictResolveKind) => void;
}

const lensRegistry = new Map<string, LensEntry>();
const APPLY_COMMAND_ID = 'prontella.conflict.applyBlock';
const LENS_KINDS: ConflictResolveKind[] = ['ours', 'theirs', 'both'];
// CodeLensProvider.onDidChange は IEvent<this> — provider 自身を流す必要がある。
const lensChange = new monaco.Emitter<monaco.languages.CodeLensProvider>();
const lensProvider: monaco.languages.CodeLensProvider = {
  onDidChange: lensChange.event,
  provideCodeLenses(model) {
    const uri = model.uri.toString();
    const entry = lensRegistry.get(uri);
    if (!entry) return { lenses: [], dispose: () => {} };
    const lenses = entry.blocks.flatMap((block, index) =>
      LENS_KINDS.map((kind) => ({
        // '<<<<<<<' 行の上に出す。同じ行の lens は Monaco が ' | ' で 1 行にまとめる。
        range: {
          startLineNumber: block.startLine + 1,
          startColumn: 1,
          endLineNumber: block.startLine + 1,
          endColumn: 1,
        },
        command: { id: APPLY_COMMAND_ID, title: entry.labels[kind], arguments: [uri, index, kind] },
      })),
    );
    return { lenses, dispose: () => {} };
  },
};

/** レジストリーを変えたら呼ぶ — Monaco に lens の再取得を促す。 */
function fireLensChange() {
  lensChange.fire(lensProvider);
}

let lensProviderReady = false;

function ensureLensProvider() {
  if (lensProviderReady) return;
  lensProviderReady = true;
  monaco.editor.registerCommand(APPLY_COMMAND_ID, (_accessor, uri: string, index: number, kind: ConflictResolveKind) => {
    lensRegistry.get(uri)?.apply(index, kind);
  });
  monaco.languages.registerCodeLensProvider('*', lensProvider);
}

// 結果ペインのスクロールエリア (overview ruler) に出す色。Monaco の ruler は CSS クラスでは
// なく色の実値を要求するので、ここだけ styles.css のトークンと二重に持つ (--green / --blue /
// --yellow のライトテーマ実測値)。背景ハイライトより濃くしないとスクロールバー幅では見えない。
const RULER_COLORS = {
  ours: 'rgba(5, 150, 105, 0.7)',
  theirs: 'rgba(37, 99, 235, 0.7)',
  marker: 'rgba(217, 119, 6, 0.85)',
} as const;

/** 競合ブロックの背景ハイライト。ours 範囲 / theirs 範囲 / マーカー行を塗り分ける。
 *  同じ範囲を overview ruler にも出して、長いファイルでも競合位置がスクロールバーで分かるようにする。 */
function conflictDecorations(blocks: ConflictBlock[]): monaco.editor.IModelDeltaDecoration[] {
  const decorations: monaco.editor.IModelDeltaDecoration[] = [];
  const wholeLine = (from: number, to: number, className: string, rulerColor: string) => {
    if (to < from) return;
    decorations.push({
      range: new monaco.Range(from, 1, to, 1),
      options: {
        isWholeLine: true,
        className,
        overviewRuler: { color: rulerColor, position: monaco.editor.OverviewRulerLane.Full },
      },
    });
  };
  for (const block of blocks) {
    // ConflictBlock の行番号は 0-based、Monaco は 1-based。範囲 [start, end) は
    // 1-based の閉区間 [start+1, end] になる。
    wholeLine(block.oursStart + 1, block.oursEnd, 'conflict-block-ours', RULER_COLORS.ours);
    wholeLine(block.theirsStart + 1, block.theirsEnd, 'conflict-block-theirs', RULER_COLORS.theirs);
    // マーカー行: '<<<<<<<' / '=======' / '>>>>>>>' と、diff3 なら '|||||||'。
    // sepLine は 0-based で theirsStart - 1 → 1-based では theirsStart。
    // baseLine は 0-based で oursEnd → 1-based では oursEnd + 1 (hasBase のときだけ)。
    const markers = [block.startLine + 1, block.theirsStart, block.endLine + 1];
    if (block.hasBase) markers.push(block.oursEnd + 1);
    for (const line of markers) wholeLine(line, line, 'conflict-marker-line', RULER_COLORS.marker);
  }
  return decorations;
}

/**
 * 3 ペインのスクロール同期。register(editor) で参加させ、返る関数で外す。
 *
 * **絶対スクロール位置 (px) で合わせる**。上段 2 枚は同じ base を土台にした差分なので、
 * これで行がそのまま対応する (ここが同期のいちばんの用途)。結果ペインは競合マーカーの
 * 行数だけ長いのでズレるが、競合の外は同じ内容なので実用上は追随する。行単位で厳密に
 * 揃えるには 3-way 整列が要るので、そこまではやらない。
 */
function useScrollSync() {
  const editorsRef = useRef(new Set<monaco.editor.ICodeEditor>());
  // setScrollTop は同期的に相手の onDidScrollChange を呼ぶので、再入を止めないと往復する。
  const busyRef = useRef(false);

  return useCallback((editor: monaco.editor.ICodeEditor) => {
    const sub = editor.onDidScrollChange((e) => {
      if (busyRef.current || (!e.scrollTopChanged && !e.scrollLeftChanged)) return;
      busyRef.current = true;
      try {
        for (const other of editorsRef.current) {
          if (other === editor) continue;
          // **既に同じ位置なら触らない**のが収束条件。3 ペインは行数が違う (結果ペインは
          // 競合マーカーの分だけ長い) ので、末尾付近では setScrollTop が clamp され、
          // 相手が別の値で鳴き返す。busyRef だけだと (Monaco が鳴き返しを次フレームに
          // 回した場合) その往復が止まらず、入力が通らなくなる。この等値判定があれば
          // clamp 後の値で 1 往復して必ず収束する。
          if (e.scrollTopChanged && other.getScrollTop() !== e.scrollTop) other.setScrollTop(e.scrollTop);
          if (e.scrollLeftChanged && other.getScrollLeft() !== e.scrollLeft) other.setScrollLeft(e.scrollLeft);
        }
      } finally {
        busyRef.current = false;
      }
    });
    editorsRef.current.add(editor);
    return () => {
      sub.dispose();
      editorsRef.current.delete(editor); // 上段は非アクティブで unmount されるので必須
    };
  }, []);
}

export default function ConflictResolvePane({
  dir,
  path,
  leafId,
  active = true,
  /** 全体採用 (resolveSide) / 解決済み (保存+ステージ) が成功した後に呼ばれる。
   *  呼び出し側で status の再取得・兄弟タブの再読込などに使う。 */
  onResolved,
}: {
  dir: string;
  path: string;
  /** タイルの leaf id (安定・leaf 間で重複しない)。Monaco モデルの名前空間に使う。 */
  leafId: string;
  /**
   * このタブが表示中か。競合タブは編集状態を保つため非アクティブでも display:none で
   * マウントされ続ける (DiffTabsPane 冒頭のコメント) が、上段の DiffEditor 2 枚まで
   * 常駐させると「タブ数だけ Monaco DiffEditor が居座って長時間セッションが劣化する」
   * 既知の問題を再発させる。上段は active のときだけマウントする (下段は常駐のまま)。
   */
  active?: boolean;
  onResolved?: () => void;
}) {
  const t = useT();
  const resolvedTheme = useTheme((s) => s.resolved);
  const { confirm: confirmDialog, dialog } = useConfirm();
  const [file, setFile] = useState<FileContent | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [topPct, setTopPct] = useState(DEFAULT_TOP_PCT);
  // onMount は ref を埋めるだけで再レンダーを起こさないので、装飾/lens を張る effect の
  // トリガー用に state も持つ。
  const [editorReady, setEditorReady] = useState(false);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const decorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const splitRef = useRef<HTMLDivElement | null>(null);
  // Monaco モデルは @monaco-editor/react のモジュールスコープ Map (path -> viewState) に
  // 登録され、そのパッケージ内に delete する経路が無い (FilesTab で先に踏んだのと同じ機構)。
  // マウントごとの乱数 (旧: crypto.randomUUID()) で名前空間を切ると、GitTab の
  // status ⇄ history 切替のたびに DiffTabsPane ごと unmount → 再マウントされてこの
  // タブも作り直され、Map にエントリーが際限なく積み上がる。leafId (タイルの leaf ごとに
  // 安定、他 leaf とは衝突しない) を名前空間に使う。判別子 `-conflict` は第 1 セグメント側
  // (ユーザーのパスが届かない位置) に付ける: `${leafId}/conflict/${path}` 形式だと、リポジトリーに
  // 実在する `conflict/...` パスを FilesTab (`${leafId}/${path}`) で開いたとき URI が完全一致し、
  // モデルを取り合って別ファイルの内容を保存し得る。leafId は 8 桁 hex 固定 (tileTree.newId) で
  // `-` を含まないため `<hex8>-conflict` はどの leafId とも一致しない。これで Map の増加は
  // 「leaf 数 × これまで開いた競合ファイル数」で頭打ちになる。
  const modelPath = `${leafId}-conflict/${path}`;

  const load = useCallback(() => {
    setError('');
    api
      .file(dir, path)
      .then((f) => {
        setFile(f);
        setDraft(f.content ?? '');
      })
      .catch((e: Error) => setError(e.message));
  }, [dir, path]);

  useEffect(() => {
    setFile(null);
    setDraft('');
    load();
  }, [load]);

  useEffect(() => () => disposeModelSoon(modelPath), [modelPath]);

  // ---- 上段 2 ペインのデータ (base vs ours / base vs theirs) ----
  // **[dir, path] で 1 回だけ取る。onResolved では取り直さない** — resolveSide や
  // 「解決済み」で index から競合が消えると :1/:2/:3 は読めなくなるため、取り直すと
  // 上段が空になる。ここ (常時マウントされる側) に持っておけば解決後も参照が残る。
  const [stages, setStages] = useState<{ ours: DiffPair; theirs: DiffPair } | null>(null);
  const [stagesError, setStagesError] = useState('');
  useEffect(() => {
    let cancelled = false;
    setStages(null);
    setStagesError('');
    Promise.all([
      api.diffPair(dir, path, 'conflict-ours'),
      api.diffPair(dir, path, 'conflict-theirs'),
    ])
      .then(([ours, theirs]) => {
        if (!cancelled) setStages({ ours, theirs });
      })
      .catch((e: Error) => {
        if (!cancelled) setStagesError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [dir, path]);

  const blocks = useMemo(() => parseConflictBlocks(draft), [draft]);

  const registerScroll = useScrollSync();

  const onMount: OnMount = (editor) => {
    editorRef.current = editor;
    setEditorReady(true);
  };

  // 結果ペインは常時マウントなので、登録も 1 回だけでよい (上段は ConflictSideDiff 側で
  // マウント/アンマウントのたびに出入りする)。
  useEffect(() => {
    if (!editorReady || !editorRef.current) return;
    return registerScroll(editorRef.current);
  }, [editorReady, registerScroll]);

  const onChange = (value: string | undefined) => setDraft(value ?? '');

  const currentModel = () => {
    const model = editorRef.current?.getModel();
    if (!model || model.uri.toString() !== monaco.Uri.parse(modelPath).toString()) return null;
    return model;
  };

  // ブロック 1 件を ours/theirs/both で解決する。Monaco の pushEditOperations で
  // ブロックの行範囲だけを置換する(undo 履歴を保つため model.setValue は使わない)。
  const applyBlock = (block: ConflictBlock, kind: ConflictResolveKind) => {
    const editor = editorRef.current;
    const model = currentModel();
    if (!editor || !model) return;
    const lines = splitLines(draft);
    const resolved = resolvedBlockLines(lines, block, kind);
    const range = new monaco.Range(
      block.startLine + 1,
      1,
      block.endLine + 1,
      lines[block.endLine].length + 1,
    );
    model.pushEditOperations(editor.getSelections(), [{ range, text: resolved.join(model.getEOL()) }], () => null);
    editor.focus();
    setMessage('');
  };

  // CodeLens のコマンドはモジュールスコープのレジストリー経由で呼ばれるので、
  // 最新の blocks/draft を掴めるよう毎レンダー差し替える ref に包む。
  const applyRef = useRef<(index: number, kind: ConflictResolveKind) => void>(() => {});
  applyRef.current = (index, kind) => {
    const block = blocks[index];
    if (block) applyBlock(block, kind);
  };

  const lensLabels = useMemo(
    (): Record<ConflictResolveKind, string> => ({
      ours: t('conflict.lensTakeOurs'),
      theirs: t('conflict.lensTakeTheirs'),
      both: t('conflict.lensTakeBoth'),
    }),
    [t],
  );

  // 結果ペインのモデルだけを lens レジストリーに載せる。アンマウント時は必ず外す
  // (外し忘れると死んだモデルの URI が残り、同じ URI で開き直したタブが古い apply を掴む)。
  useEffect(() => {
    if (!editorReady) return;
    ensureLensProvider();
    const uri = monaco.Uri.parse(modelPath).toString();
    lensRegistry.set(uri, {
      blocks,
      labels: lensLabels,
      apply: (index, kind) => applyRef.current(index, kind),
    });
    fireLensChange();
    return () => {
      lensRegistry.delete(uri);
      fireLensChange();
    };
  }, [editorReady, modelPath, blocks, lensLabels]);

  // 競合範囲の背景ハイライト。draft が変わるたびに張り直す。
  useEffect(() => {
    if (!editorReady) return;
    const editor = editorRef.current;
    const model = currentModel();
    if (!editor || !model) return;
    const decorations = conflictDecorations(blocks);
    if (decorationsRef.current) decorationsRef.current.set(decorations);
    else decorationsRef.current = editor.createDecorationsCollection(decorations);
  }, [editorReady, blocks, modelPath]);

  useEffect(
    () => () => {
      decorationsRef.current?.clear();
      decorationsRef.current = null;
    },
    [],
  );

  const revealBlock = (block: ConflictBlock) => {
    editorRef.current?.revealLineInCenter(block.startLine + 1);
  };

  // ファイル全体を ours/theirs で採用する (api.resolveSide = checkout --ours|theirs + add
  // 済みなので呼び出し後は自動的にステージ済みになる)。エディター上の未保存の編集を
  // 問答無用で上書きするため破壊的操作 → ConfirmDialog(danger) 経由。
  const resolveWholeFile = async (side: ConflictSide) => {
    const dirty = draft !== (file?.content ?? '');
    const ok = await confirmDialog({
      title: t('conflict.resolveWholeTitle', { side }),
      message: (
        <>
          <div>{t('conflict.resolveWholeMessage', { path, sideLabel: t(SIDE_LABEL_KEYS[side]) })}</div>
          {dirty && <div>{t('conflict.unsavedWillBeDiscarded')}</div>}
          <div>{t('git.cannotUndo')}</div>
        </>
      ),
      confirmLabel: t('git.resolve'),
      severity: 'danger',
    });
    if (!ok) return;
    setBusy(true);
    setMessage('');
    try {
      await api.resolveSide(dir, path, side);
      const f = await api.file(dir, path);
      setFile(f);
      setDraft(f.content ?? '');
      const model = currentModel();
      if (f.content !== null && model) model.setValue(f.content);
      setMessage(`✓ ${t('conflict.resolvedSideSuccess', { side })}`);
      onResolved?.();
    } catch (e) {
      setMessage(`⚠ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // 残マーカー 0 のときだけ有効。保存 (読み込み時の encoding/BOM を維持) → ステージの順。
  const resolve = async () => {
    if (blocks.length > 0 || !file || file.content === null) return;
    setBusy(true);
    setMessage('');
    try {
      const model = currentModel();
      const content = model ? model.getValue() : draft;
      const enc = { encoding: file.encoding ?? 'utf-8', bom: file.hasBom };
      await api.saveFile(dir, path, content, enc);
      await api.stage(dir, path);
      setFile((f) => (f ? { ...f, content, encoding: enc.encoding, hasBom: enc.bom } : f));
      setDraft(content);
      setMessage(`✓ ${t('conflict.savedAndStagedSuccess')}`);
      onResolved?.();
    } catch (e) {
      setMessage(`⚠ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // 上下の比率をドラッグで変える。react-resizable-panels を使わないのは、競合タブが
  // display:none で常時マウントされるため — 畳まれた (幅 0 の) Group で Panel が
  // 部分再登録され、サイズ契約が壊れる既知の罠を踏む (pj-client-ui-state §11/§17)。
  const onDividerDown = (e: React.PointerEvent) => {
    const host = splitRef.current;
    if (!host) return;
    e.preventDefault();
    const rect = host.getBoundingClientRect();
    if (rect.height <= 0) return;
    const move = (ev: PointerEvent) => {
      const pct = ((ev.clientY - rect.top) / rect.height) * 100;
      setTopPct(Math.max(0, Math.min(MAX_TOP_PCT, pct)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // :1/:2/:3 がどれも読めない = 既に解決済み (index から競合が消えた) か、バイナリー。
  const stagesEmpty =
    !!stages &&
    !stages.ours.modified &&
    !stages.theirs.modified &&
    !stages.ours.original &&
    !stages.theirs.original;

  const sideDiff = (pair: DiffPair | undefined, labelKey: StringKey, kind: 'ours' | 'theirs') => (
    <div className="conflict-side">
      <div className="conflict-side-head">{t(labelKey)}</div>
      <div className="conflict-side-body">
        {stagesError ? (
          <div className="placeholder">⚠ {stagesError}</div>
        ) : !pair ? (
          <div className="placeholder">{t('common.loading')}</div>
        ) : stagesEmpty || pair.binary || pair.tooLarge ? (
          <div className="placeholder">{t('conflict.stagesUnavailable')}</div>
        ) : (
          <ConflictSideDiff
            original={pair.original}
            modified={pair.modified}
            language={languageFor(path)}
            theme={monacoThemeName(resolvedTheme)}
            registerScroll={registerScroll}
            // ours / theirs でモデルの URI を分ける (DiffEditor は path を持たないので
            // key で作り分けるだけ。取り違えの実害は無いが再マウント境界を明示する)。
            key={kind}
          />
        )}
      </div>
    </div>
  );

  return (
    <div className="conflict-pane-inner">
      <div className="conflict-toolbar">
        <span className="diff-path" title={path}>
          {path}
        </span>
        <span className={`conflict-marker-count ${blocks.length === 0 ? 'ok' : ''}`}>
          {blocks.length > 0
            ? `⚠ ${t('conflict.unresolvedCount', { n: blocks.length })}`
            : `✓ ${t('conflict.noMarkers')}`}
        </span>
        <span className="conflict-toolbar-msg">{message}</span>
      </div>
      {blocks.length > 0 && (
        <div className="hunk-strip conflict-strip">
          <div className="hunk-strip-list">
            {blocks.map((block, index) => (
              <div key={index} className="hunk-chip">
                <button
                  className="hunk-chip-loc"
                  title={t('git.scrollToTooltip')}
                  onClick={() => revealBlock(block)}
                >
                  {t('conflict.blockLabel', { n: index + 1 })}
                  {block.hasBase ? ' (diff3)' : ''}
                  {block.oursLabel && ` — ours: ${block.oursLabel}`}
                  {block.theirsLabel && ` / theirs: ${block.theirsLabel}`}
                </button>
                <span className="hunk-chip-actions conflict-chip-actions">
                  <button
                    disabled={busy}
                    title={t('conflict.applyOursTooltip')}
                    onClick={() => applyBlock(block, 'ours')}
                  >
                    ours
                  </button>
                  <button
                    disabled={busy}
                    title={t('conflict.applyTheirsTooltip')}
                    onClick={() => applyBlock(block, 'theirs')}
                  >
                    theirs
                  </button>
                  <button
                    disabled={busy}
                    title={t('conflict.applyBothTooltip')}
                    onClick={() => applyBlock(block, 'both')}
                  >
                    both
                  </button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="conflict-split" ref={splitRef} style={{ gridTemplateRows: `${topPct}% 6px 1fr` }}>
        <div className="conflict-split-top">
          {/* 上段は active のときだけマウントする (props の active コメント参照)。 */}
          {active && sideDiff(stages?.ours, 'conflict.paneCurrent', 'ours')}
          {active && sideDiff(stages?.theirs, 'conflict.paneIncoming', 'theirs')}
        </div>
        <div
          className="conflict-divider"
          title={t('conflict.splitDividerTooltip')}
          onPointerDown={onDividerDown}
        />
        <div className="conflict-result">
          <div className="conflict-side-head">{t('conflict.paneResult')}</div>
          <div className="conflict-editor-host">
            {error ? (
              <div className="placeholder">⚠ {error}</div>
            ) : !file ? (
              <div className="placeholder">{t('common.loading')}</div>
            ) : file.binary ? (
              <div className="placeholder">{t('conflict.binaryMessage', { size: file.size })}</div>
            ) : file.tooLarge ? (
              <div className="placeholder">
                {t('conflict.tooLargeMessage', { size: Math.round(file.size / 1024) })}
              </div>
            ) : (
              // FilesTab と同じく uncontrolled: defaultValue は初回のみ、以降は onChange のみで
              // draft へ反映する (value prop は渡さない)。
              <Editor
                path={modelPath}
                defaultValue={draft}
                onChange={onChange}
                onMount={onMount}
                keepCurrentModel
                language={languageFor(path)}
                theme={monacoThemeName(resolvedTheme)}
                options={EDITOR_OPTIONS}
              />
            )}
          </div>
        </div>
      </div>
      <div className="conflict-actions-bar">
        <span className="conflict-actions-left">
          <button disabled={busy} onClick={() => void resolveWholeFile('ours')}>
            {t('conflict.resolveOursButton')}
          </button>
          <button disabled={busy} onClick={() => void resolveWholeFile('theirs')}>
            {t('conflict.resolveTheirsButton')}
          </button>
        </span>
        <button
          className="primary"
          disabled={busy || blocks.length > 0 || !file || file.content === null}
          title={blocks.length > 0 ? t('conflict.unresolvedRemainingTooltip', { n: blocks.length }) : ''}
          onClick={() => void resolve()}
        >
          {t('conflict.resolvedButton')}
        </button>
      </div>
      {dialog}
    </div>
  );
}

/**
 * 上段の読み取り専用 DiffEditor。DiffPane の DisposableDiffEditor と同じ理由で
 * モデルの後始末を自前でやる: @monaco-editor/react (v4.7.0) は
 * 「モデル dispose → DiffEditorWidget dispose」の逆順で片付けるため、Monaco 0.55 の
 * DiffEditorWidget が BugIndicatingError('TextModel got disposed before
 * DiffEditorWidget model got reset') をコンソールに吐く。keepCurrent* で所有権を
 * こちらに移し、setModel(null) → dispose の正しい順で片付ける。
 * (DiffPane 側は編集・保存・ステータスバー・ハンク操作の配線を抱えていて再利用できないので、
 *  ここでは後始末の 4 行だけを同じ形で持つ。)
 */
function ConflictSideDiff({
  original,
  modified,
  language,
  theme,
  registerScroll,
}: {
  original: string;
  modified: string;
  language: string | undefined;
  theme: string;
  /** スクロール同期への参加。返り値の関数をアンマウント時に必ず呼ぶ。 */
  registerScroll: (editor: monaco.editor.ICodeEditor) => () => void;
}) {
  const editorRef = useRef<MonacoDiffEditor | null>(null);
  const unregisterRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      const editor = editorRef.current;
      editorRef.current = null;
      unregisterRef.current?.(); // 購読を外すのはモデルを壊す前
      unregisterRef.current = null;
      if (!editor) return; // フェッチ完了前のアンマウントでは未生成
      const models = editor.getModel();
      editor.setModel(null); // 先に widget からモデルを外す
      models?.original?.dispose();
      models?.modified?.dispose();
    },
    [],
  );
  return (
    <DiffEditor
      original={original}
      modified={modified}
      language={language}
      theme={theme}
      // モデルの破棄は上の cleanup が担う。このフラグ「だけ」を足すと誰も dispose せず
      // リークするので、必ず cleanup とセットで扱うこと。
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      options={SIDE_DIFF_OPTIONS}
      onMount={(editor) => {
        editorRef.current = editor;
        // inline (renderSideBySide: false) では見えているのは modified 側のエディター。
        // original 側は非表示なので同期に入れても意味がない。
        unregisterRef.current = registerScroll(editor.getModifiedEditor());
      }}
    />
  );
}
