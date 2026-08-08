import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { api } from '../api';
import {
  parseConflictBlocks,
  resolvedBlockLines,
  splitLines,
  type ConflictBlock,
  type ConflictResolveKind,
} from '../conflictBlocks';
import { languageFor } from '../monaco-setup';
import { monacoThemeName } from '../theme/monacoTheme';
import { useTheme } from '../theme/themeStore';
import type { ConflictSide, FileContent } from '../types';
import { useConfirm } from './ConfirmDialog';

/**
 * 競合ファイル (StatusFile.conflicted) を開いて解決するペイン。DiffTabsPane の
 * タブとして DiffPane と並んでホストされる (kind: 'conflict')。
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

const SIDE_LABEL: Record<ConflictSide, string> = {
  ours: '現在のブランチ側 (ours)',
  theirs: 'マージ相手側 (theirs)',
};

function disposeModelSoon(uriPath: string) {
  setTimeout(() => monaco.editor.getModel(monaco.Uri.parse(uriPath))?.dispose(), 0);
}

export default function ConflictResolvePane({
  dir,
  path,
  leafId,
  /** 全体採用 (resolveSide) / 解決済み (保存+ステージ) が成功した後に呼ばれる。
   *  呼び出し側で status の再取得・兄弟タブの再読込などに使う。 */
  onResolved,
}: {
  dir: string;
  path: string;
  /** タイルの leaf id (安定・leaf 間で重複しない)。Monaco モデルの名前空間に使う。 */
  leafId: string;
  onResolved?: () => void;
}) {
  const resolvedTheme = useTheme((s) => s.resolved);
  const { confirm: confirmDialog, dialog } = useConfirm();
  const [file, setFile] = useState<FileContent | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
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

  const blocks = useMemo(() => parseConflictBlocks(draft), [draft]);

  const onMount: OnMount = (editor) => {
    editorRef.current = editor;
  };

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

  const revealBlock = (block: ConflictBlock) => {
    editorRef.current?.revealLineInCenter(block.startLine + 1);
  };

  // ファイル全体を ours/theirs で採用する (api.resolveSide = checkout --ours|theirs + add
  // 済みなので呼び出し後は自動的にステージ済みになる)。エディター上の未保存の編集を
  // 問答無用で上書きするため破壊的操作 → ConfirmDialog(danger) 経由。
  const resolveWholeFile = async (side: ConflictSide) => {
    const dirty = draft !== (file?.content ?? '');
    const ok = await confirmDialog({
      title: `ファイル全体を ${side} で解決`,
      message: (
        <>
          <div>
            {path} の内容全体を{SIDE_LABEL[side]}で上書きします(自動的にステージされます)。
          </div>
          {dirty && <div>※ エディター上の未保存の編集は破棄されます。</div>}
          <div>※ 元に戻せません</div>
        </>
      ),
      confirmLabel: '解決',
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
      setMessage(`✓ ${side} で解決しました (ステージ済み)`);
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
      setMessage('✓ 保存してステージしました');
      onResolved?.();
    } catch (e) {
      setMessage(`⚠ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="conflict-pane-inner">
      <div className="conflict-toolbar">
        <span className="diff-path" title={path}>
          {path}
        </span>
        <span className={`conflict-marker-count ${blocks.length === 0 ? 'ok' : ''}`}>
          {blocks.length > 0 ? `⚠ 未解決の競合 ${blocks.length} 件` : '✓ 競合マーカーなし'}
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
                  title="この位置へスクロール"
                  onClick={() => revealBlock(block)}
                >
                  競合 {index + 1}
                  {block.hasBase ? ' (diff3)' : ''}
                  {block.oursLabel && ` — ours: ${block.oursLabel}`}
                  {block.theirsLabel && ` / theirs: ${block.theirsLabel}`}
                </button>
                <span className="hunk-chip-actions conflict-chip-actions">
                  <button disabled={busy} title="この行をours採用" onClick={() => applyBlock(block, 'ours')}>
                    ours
                  </button>
                  <button disabled={busy} title="この行をtheirs採用" onClick={() => applyBlock(block, 'theirs')}>
                    theirs
                  </button>
                  <button disabled={busy} title="ours→theirsの順で両方残す" onClick={() => applyBlock(block, 'both')}>
                    both
                  </button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="conflict-editor-host">
        {error ? (
          <div className="placeholder">⚠ {error}</div>
        ) : !file ? (
          <div className="placeholder">読み込み中...</div>
        ) : file.binary ? (
          <div className="placeholder">
            バイナリファイルは表示できません ({file.size} bytes)。「ファイル全体を ours/theirs」で解決してください
          </div>
        ) : file.tooLarge ? (
          <div className="placeholder">
            ファイルが大きすぎます ({Math.round(file.size / 1024)} KB)。「ファイル全体を ours/theirs」で解決してください
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
      <div className="conflict-actions-bar">
        <span className="conflict-actions-left">
          <button disabled={busy} onClick={() => void resolveWholeFile('ours')}>
            ファイル全体を ours で解決
          </button>
          <button disabled={busy} onClick={() => void resolveWholeFile('theirs')}>
            ファイル全体を theirs で解決
          </button>
        </span>
        <button
          className="primary"
          disabled={busy || blocks.length > 0 || !file || file.content === null}
          title={blocks.length > 0 ? `未解決の競合が ${blocks.length} 件残っています` : ''}
          onClick={() => void resolve()}
        >
          解決済み (保存してステージ)
        </button>
      </div>
      {dialog}
    </div>
  );
}
