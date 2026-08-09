import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { DiffEditor, type MonacoDiffEditor } from '@monaco-editor/react';
import { api } from '../api';
import { useT } from '../i18n';
import { languageFor } from '../monaco-setup';
import { parseHunkHeader } from '../diffHunk';
import { monacoThemeName } from '../theme/monacoTheme';
import { useTheme } from '../theme/themeStore';
import type { DiffHunk, DiffPair } from '../types';
import DiffHunkStrip from './DiffHunkStrip';

interface DiffPaneProps {
  dir: string;
  path: string;
  scope: 'worktree' | 'staged' | 'commit';
  hash?: string;
  origPath?: string | null;
  /** untracked ファイルは合成 diff (index に実体がない) なのでハンク単位操作の対象外にする */
  untracked?: boolean;
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
  onHunksChanged,
}: DiffPaneProps) {
  const t = useT();
  const [pair, setPair] = useState<DiffPair | null>(null);
  const [error, setError] = useState('');
  const diffEditorRef = useRef<MonacoDiffEditor | null>(null);

  // ハンク適用後の再取得用に切り出し。読み込み中プレースホルダーへは戻さない
  // (pair が既にあるまま裏で取り直し、届いたら差し替える — 全体リロードは既存の
  // 「差分を取り直す」ボタン (DiffTabsPane の gen/reloadKey) の役目のまま)。
  const loadPair = useCallback(() => {
    api
      .diffPair(dir, path, scope, { hash, origPath: origPath ?? undefined })
      .then((p) => {
        setPair(p);
        setError('');
      })
      .catch((e: Error) => setError(e.message));
  }, [dir, path, scope, hash, origPath]);

  useEffect(() => {
    setPair(null);
    setError('');
    loadPair();
  }, [loadPair]);

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

  if (error) return <div className="placeholder">⚠ {error}</div>;
  if (!pair) return <div className="placeholder">{t('common.loading')}</div>;
  if (pair.binary) return <div className="placeholder">{t('diff.binaryUnsupported')}</div>;
  if (pair.tooLarge) return <div className="placeholder">{t('diff.tooLarge')}</div>;
  if (pair.original === pair.modified) return <div className="placeholder">{t('diff.noDiff')}</div>;

  // commit scope と untracked ファイルの合成 diff にはハンク単位操作を出さない
  // (サーバー側 diff-hunks も scope=worktree/staged しか受け付けない)。
  const hunkScope = scope === 'worktree' || scope === 'staged' ? scope : null;

  return (
    <div className="diff-pane-inner">
      {hunkScope && !untracked && (
        <DiffHunkStrip
          dir={dir}
          path={path}
          scope={hunkScope}
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
        />
      </div>
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
}: {
  original: string;
  modified: string;
  language: string | undefined;
  /** DiffPane の revealHunk が使う ref。useRef 由来なので識別子は永続的に安定 */
  editorRef: MutableRefObject<MonacoDiffEditor | null>;
}) {
  const resolvedTheme = useTheme((s) => s.resolved);
  useEffect(
    () => () => {
      const editor = editorRef.current;
      editorRef.current = null; // 親に stale 参照を残さない
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
      }}
      options={{
        readOnly: true,
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
