import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { DiffEditor, type MonacoDiffEditor } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { api } from '../api';
import { bumpGitEpoch } from '../gitEpoch';
import { useT } from '../i18n';
import { languageFor } from '../monaco-setup';
import { parseHunkHeader } from '../diffHunk';
import { monacoThemeName } from '../theme/monacoTheme';
import { useTheme } from '../theme/themeStore';
import type { DiffHunk, DiffPair } from '../types';
import { useConfirm } from './ConfirmDialog';
import DiffHunkStrip from './DiffHunkStrip';
import EditorStatusBar from './EditorStatusBar';

/** 差分エディターの内側 2 エディター。ステータスバーの購読先。 */
interface DiffSides {
  original: monaco.editor.IStandaloneCodeEditor;
  modified: monaco.editor.IStandaloneCodeEditor;
}

interface DiffPaneProps {
  dir: string;
  path: string;
  scope: 'worktree' | 'staged' | 'commit';
  hash?: string;
  origPath?: string | null;
  /** untracked ファイルは合成 diff (index に実体がない) なのでハンク単位操作の対象外にする */
  untracked?: boolean;
  /**
   * 右側 (modified) を編集して保存できるようにする。呼び出し元は scope='worktree' の
   * ときだけ true を渡すこと — その場合に限り modified 側が「作業ツリーの実ファイル」で、
   * PUT /api/fs/file にそのまま書き戻せる。staged (index の blob) や commit では
   * 保存先が存在しないので、渡してはいけない。
   */
  editable?: boolean;
  /** 未保存の編集の有無が変わったときに呼ばれる。呼び出し元がタブの寿命を守るために使う。 */
  onDirtyChange?: (dirty: boolean) => void;
  /** 保存に成功したときに呼ばれる (Git ステータスの再取得用)。 */
  onSaved?: () => void;
  /**
   * このタブでハンク操作 (stage/unstage/discard) が成功したときに呼ばれる。
   * 同じファイルを別スコープで表示している兄弟タブの再読込を、呼び出し元
   * (DiffTabsPane) にトリガーさせるためのフック (省略可。commit scope では使われない)。
   */
  onHunksChanged?: () => void;
}

export default function DiffPane({
  dir,
  path,
  scope,
  hash,
  origPath,
  untracked,
  editable,
  onDirtyChange,
  onSaved,
  onHunksChanged,
}: DiffPaneProps) {
  const t = useT();
  const { confirm: confirmDialog, dialog } = useConfirm();
  const [pair, setPair] = useState<DiffPair | null>(null);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  // ステータスバーの「エンコーディングを指定して再読み込み」で選ばれた値。
  // null なら diff-pair のサーバー側自動判定に任せる。
  const [encodingOverride, setEncodingOverride] = useState<string | null>(null);
  // 同じエンコーディングを選び直したときも取り直させるための世代カウンター
  const [reloadGen, setReloadGen] = useState(0);
  const diffEditorRef = useRef<MonacoDiffEditor | null>(null);
  // ステータスバーは Monaco のインスタンスに購読を張るので、ref ではなく state で持つ
  // (ref だと生成時に再レンダーが起きず、フッターが空のままになる)。
  const [sides, setSides] = useState<DiffSides | null>(null);
  // カーソル位置はフォーカスされている側を表示する (VS Code と同じ)。
  const [focusedSide, setFocusedSide] = useState<'original' | 'modified'>('modified');
  // 保存後にベースラインを更新するので state ではなく ref に置く (dirty 判定は
  // Monaco のイベントハンドラーから同期的に読む必要があり、再レンダーを待てない)。
  const baselineRef = useRef('');

  // ハンク適用後の再取得用に切り出し。読み込み中プレースホルダーへは戻さない
  // (pair が既にあるまま裏で取り直し、届いたら差し替える — 全体リロードは既存の
  // 「差分を取り直す」ボタン (DiffTabsPane の gen/reloadKey) の役目のまま)。
  const loadPair = useCallback(() => {
    api
      .diffPair(dir, path, scope, {
        hash,
        origPath: origPath ?? undefined,
        encoding: encodingOverride ?? undefined,
      })
      .then((p) => {
        setPair(p);
        setError('');
        baselineRef.current = p.modified;
        setDirty(false);
      })
      .catch((e: Error) => setError(e.message));
    // reloadGen は値としては使わないが、同値の再指定でも再取得させるために依存に入れる
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir, path, scope, hash, origPath, encodingOverride, reloadGen]);

  useEffect(() => {
    setPair(null);
    setError('');
    setMessage('');
    loadPair();
  }, [loadPair]);

  // 親には「未保存かどうか」だけを伝える。
  //
  // **値が実際に変わったときだけ**呼ぶこと。呼び出し元はインラインのアロー関数を
  // 渡すので identity が毎レンダー変わる。それを依存配列に入れると、レンダーのたびに
  // 「アンマウント扱いの false → 現在値」の往復が起き、親側が凍結していた再マウント
  // key を一瞬解除してしまう (= Git 操作と重なると未保存の編集が無言で消える)。
  // コールバックは ref 経由で最新のものを呼び、アンマウント通知は [] で 1 回だけにする。
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  const reportedDirtyRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (reportedDirtyRef.current === dirty) return;
    reportedDirtyRef.current = dirty;
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);
  // アンマウント時は必ず false に戻す (dirty のまま消えると親の dirtyKeys に幽霊が
  // 残り、そのタブが常駐し続ける)。
  useEffect(() => () => onDirtyChangeRef.current?.(false), []);

  const revealHunk = useCallback((hunk: DiffHunk) => {
    const editor = diffEditorRef.current;
    const pos = parseHunkHeader(hunk.header);
    if (!editor || !pos) return;
    // '+' 側 (追加/変更) があれば modified 側、純削除ハンク (newLines: 0) は original 側を開く。
    if (pos.newLines > 0) {
      editor.getModifiedEditor().revealLineInCenter(pos.newStart);
    } else {
      editor.getOriginalEditor().revealLineInCenter(Math.max(pos.oldStart, 1));
    }
  }, []);

  const save = useCallback(
    async (encOverride?: { encoding: string; bom: boolean }) => {
      const editor = diffEditorRef.current;
      const model = editor?.getModel()?.modified;
      if (!editor || !model || !pair) return;
      const content = model.getValue();
      // 読み込み時に検出したエンコーディング / BOM をそのまま維持する。ここを
      // utf-8 固定にすると Shift_JIS 等のファイルを保存で壊す (diff-pair が
      // encoding を返すのはこのため)。encOverride はステータスバーの
      // 「エンコーディングを指定して保存」由来 (未編集でも変換のために書く)。
      const enc = encOverride ?? { encoding: pair.encoding ?? 'utf-8', bom: pair.hasBom };
      setSaving(true);
      setMessage('');
      try {
        await api.saveFile(dir, path, content, enc);
        baselineRef.current = content;
        setPair((p) =>
          p ? { ...p, modified: content, encoding: enc.encoding, hasBom: enc.bom } : p,
        );
        setDirty(false);
        setMessage(`✓ ${t('files.savedMessage')}`);
        setTimeout(() => setMessage(''), 2500);
        // 作業ツリーが変わったので、ファイルパネルのガターと Git ステータスを更新させる。
        bumpGitEpoch(dir);
        onSaved?.();
      } catch (e) {
        setMessage(`⚠ ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setSaving(false);
      }
    },
    [dir, path, pair, t, onSaved],
  );

  // Monaco のコマンドは登録時のクロージャーを掴むので、最新の save を ref 経由で呼ぶ。
  const saveRef = useRef(save);
  saveRef.current = save;

  /**
   * ステータスバーの「エンコーディングを指定して再読み込み」。
   * 取り直しは未保存の編集を捨てるので、dirty のときだけ確認する
   * (FilesTab の同名操作と同じ扱い。文言も共用する)。
   */
  const reloadWithEncoding = useCallback(
    async (encoding: string) => {
      if (dirty) {
        const ok = await confirmDialog({
          title: t('files.reloadTitle'),
          message: t('files.reloadDiscardMessage', { name: path }),
          confirmLabel: t('files.discardAndReload'),
          severity: 'danger',
        });
        if (!ok) return;
      }
      // encodingOverride / reloadGen が変わると loadPair の identity が変わり、
      // 再取得の useEffect が走る。gen も上げるのは、**同じエンコーディングを
      // 選び直したときに無反応にならない**ようにするため (state の値だけを見ると
      // 同値では再レンダーが起きず、メニューを押しても何も起きないように見える)。
      setEncodingOverride(encoding);
      setReloadGen((g) => g + 1);
      setDirty(false);
    },
    [dirty, confirmDialog, t, path],
  );

  if (error) return <div className="placeholder">⚠ {error}</div>;
  if (!pair) return <div className="placeholder">{t('common.loading')}</div>;
  if (pair.binary) return <div className="placeholder">{t('diff.binaryUnsupported')}</div>;
  if (pair.tooLarge) return <div className="placeholder">{t('diff.tooLarge')}</div>;
  // 編集可能なタブでは「差分なし」でもエディターを出し続ける — 編集して元の内容に
  // 戻した (= original と一致した) 瞬間にペインが消えると、そこから先が操作不能になる。
  if (!editable && pair.original === pair.modified) {
    return <div className="placeholder">{t('diff.noDiff')}</div>;
  }

  // 作業ツリーから消えたファイルは書き戻す先が無いので編集させない。
  const canEdit = !!editable && !pair.modifiedMissing;

  // commit scope と untracked ファイルの合成 diff にはハンク単位操作を出さない
  // (サーバー側 diff-hunks も scope=worktree/staged しか受け付けない)。
  const hunkScope = scope === 'worktree' || scope === 'staged' ? scope : null;

  return (
    <div className="diff-pane-inner">
      {canEdit && (
        <div className="diff-edit-bar">
          {dirty && <span className="editor-tab-dirty">●</span>}
          <span className="diff-edit-status">
            {dirty ? t('difftabs.unsaved') : message || t('difftabs.editableHint')}
          </span>
          <button
            className="primary"
            disabled={!dirty || saving}
            title={t('difftabs.saveTooltip')}
            onClick={() => void save()}
          >
            {t('difftabs.save')}
          </button>
        </div>
      )}
      {editable && pair.modifiedMissing && (
        <div className="diff-edit-bar">
          <span className="diff-edit-status">{t('difftabs.readOnlyDeleted')}</span>
        </div>
      )}
      {hunkScope && !untracked && (
        <DiffHunkStrip
          dir={dir}
          path={path}
          scope={hunkScope}
          disabled={dirty}
          disabledReason={t('difftabs.hunkDisabledDirty')}
          onApplied={loadPair}
          onHunkStateChanged={onHunksChanged}
          onReveal={revealHunk}
        />
      )}
      <div className="diff-editor-host">
        <DisposableDiffEditor
          original={pair.original}
          modified={pair.modified}
          language={languageFor(path)}
          editorRef={diffEditorRef}
          editable={canEdit}
          baselineRef={baselineRef}
          onDirty={setDirty}
          onSave={() => void saveRef.current()}
          onSides={setSides}
          onFocusSide={setFocusedSide}
        />
      </div>
      {/* フッター。パスは上の diff-toolbar に既に出ているので出さない。
          インデント / EOL の表示元と変更先は **modified 側に固定**する:
          original 側は index/HEAD の内容で書き戻し先が無く、そこへ pushEOL すると
          差分が全行変更に化ける。位置表示だけはフォーカスされている側に追従させる。 */}
      <EditorStatusBar
        editor={sides?.modified ?? null}
        positionEditor={(focusedSide === 'original' ? sides?.original : sides?.modified) ?? null}
        activePath={path}
        showPath={false}
        file={pair}
        readOnly={!canEdit}
        onReloadWithEncoding={(encoding) => void reloadWithEncoding(encoding)}
        onSaveWithEncoding={canEdit ? (encoding, bom) => void save({ encoding, bom }) : undefined}
      />
      {dialog}
    </div>
  );
}

/**
 * @monaco-editor/react の DiffEditor は、アンマウント時の後始末を
 * 「original/modified の TextModel を dispose → DiffEditorWidget を dispose」の逆順で行う
 * (v4.7.0 時点)。Monaco 0.55 の DiffEditorWidget はモデルを保持したままモデルが dispose されると
 * BugIndicatingError('TextModel got disposed before DiffEditorWidget model got reset') を
 * onUnexpectedError に流し、既定ハンドラーが setTimeout で再 throw するのでコンソールに
 * Uncaught Error が出る (diffEditorWidget.js:238-243 / errors.js:9-19)。
 * そこで keepCurrent* でモデルの所有権をこちらに移し、setModel(null) → dispose の正しい順で
 * 自前に片付ける。
 *
 * DiffPane 本体ではなくこの粒度で分けているのは、DiffPane が生き残ったまま pair が null に戻る
 * 経路 (HistoryTab / FileHistoryModal は DiffPane に key を付けず props だけ差し替えるため、
 * setPair(null) で <DiffEditor> だけがアンマウントされる) でも cleanup を確実に走らせるため。
 * cleanup を DiffPane の useEffect(..., []) に置くとこの経路を取り逃し、keepCurrent* だけが
 * 効いてモデルがリークする (実測: 10 回切替でモデル 2 → 22)。
 */
function DisposableDiffEditor({
  original,
  modified,
  language,
  editorRef,
  editable,
  baselineRef,
  onDirty,
  onSave,
  onSides,
  onFocusSide,
}: {
  original: string;
  modified: string;
  language: string | undefined;
  /** DiffPane の revealHunk が使う ref。useRef 由来なので識別子は永続的に安定 */
  editorRef: MutableRefObject<MonacoDiffEditor | null>;
  editable: boolean;
  /** 保存済みの内容 (dirty 判定の基準)。保存のたびに DiffPane が書き換える。 */
  baselineRef: MutableRefObject<string>;
  onDirty: (dirty: boolean) => void;
  onSave: () => void;
  /** ステータスバー用に内側の 2 エディターを親へ渡す。アンマウント時は null。 */
  onSides: (sides: DiffSides | null) => void;
  /** カーソル位置をどちら側から読むかを親へ伝える。 */
  onFocusSide: (side: 'original' | 'modified') => void;
}) {
  const resolvedTheme = useTheme((s) => s.resolved);
  // modified モデルの内容購読。DiffEditor は props が変わるとモデルを作り直すので、
  // onDidChangeModel のたびに張り直す必要がある (1 回だけ張ると保存後に効かなくなる)。
  const contentSubRef = useRef<monaco.IDisposable | null>(null);
  const modelSubRef = useRef<monaco.IDisposable | null>(null);
  const keySubRef = useRef<monaco.IDisposable | null>(null);
  const focusSubsRef = useRef<monaco.IDisposable[]>([]);
  // cleanup は [editorRef] で 1 回だけ張るので、親から来るコールバックは ref 経由で読む
  // (state セッターなので実際には安定だが、依存関係をここで固定しておく)。
  const onSidesRef = useRef(onSides);
  onSidesRef.current = onSides;

  useEffect(
    () => () => {
      const editor = editorRef.current;
      editorRef.current = null; // 親に stale 参照を残さない
      contentSubRef.current?.dispose();
      contentSubRef.current = null;
      modelSubRef.current?.dispose();
      modelSubRef.current = null;
      keySubRef.current?.dispose();
      keySubRef.current = null;
      focusSubsRef.current.forEach((d) => d.dispose());
      focusSubsRef.current = [];
      onSidesRef.current(null); // ステータスバーが死んだインスタンスを掴み続けないように
      if (!editor) return; // フェッチ完了前のアンマウントでは未生成
      const models = editor.getModel();
      editor.setModel(null); // 先に widget からモデルを外す (onWillDispose の購読も解ける)
      models?.original?.dispose();
      models?.modified?.dispose();
    },
    [editorRef],
  );

  return (
    <DiffEditor
      original={original}
      modified={modified}
      language={language}
      theme={monacoThemeName(resolvedTheme)}
      // モデルの破棄は上の cleanup が担う。このフラグ「だけ」を足すと誰も dispose せず
      // リークするので、必ず cleanup とセットで扱うこと。
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      onMount={(editor) => {
        editorRef.current = editor;
        const modifiedEditor = editor.getModifiedEditor();
        const originalEditor = editor.getOriginalEditor();
        // ステータスバーは読み取り専用の差分でも出すので、購読は editable の判定より前に張る。
        onSides({ original: originalEditor, modified: modifiedEditor });
        focusSubsRef.current = [
          originalEditor.onDidFocusEditorText(() => onFocusSide('original')),
          modifiedEditor.onDidFocusEditorText(() => onFocusSide('modified')),
        ];
        if (!editable) return;
        // Ctrl+S は onKeyDown で拾う。DiffEditor の内側エディターに
        // `addCommand(CtrlCmd|KeyS, ...)` を登録しても**発火しない** — 標準の
        // キーバインドはエディター単位のコンテキストキーで絞られるが、diff editor の
        // 内側エディターにはそれが設定されないため when 句が成立しないため。
        // (実測: modified 側にフォーカスがある状態で Ctrl+S を送っても保存されず、
        //  保存ボタンでは保存された。FilesTab 側の単体エディターでは addCommand が効く。)
        keySubRef.current = modifiedEditor.onKeyDown((e) => {
          if ((e.ctrlKey || e.metaKey) && !e.altKey && e.keyCode === monaco.KeyCode.KeyS) {
            e.preventDefault(); // ブラウザーの「ページを保存」を抑止する
            e.stopPropagation();
            onSave();
          }
        });
        const attach = () => {
          contentSubRef.current?.dispose();
          const model = modifiedEditor.getModel();
          if (!model) return;
          contentSubRef.current = model.onDidChangeContent(() => {
            onDirty(model.getValue() !== baselineRef.current);
          });
        };
        modelSubRef.current = modifiedEditor.onDidChangeModel(attach);
        attach();
      }}
      options={{
        // readOnly は modified 側にだけ効く。左側 (original) は index / HEAD の内容で
        // 書き戻し先が無いので、originalEditable は常に false のままにする。
        readOnly: !editable,
        originalEditable: false,
        renderSideBySide: true,
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 13,
        renderOverviewRuler: true,
        diffWordWrap: 'off',
      }}
    />
  );
}
