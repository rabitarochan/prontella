import { useCallback, useEffect, useRef, useState } from 'react';
import { DiffEditor, type DiffOnMount, type MonacoDiffEditor } from '@monaco-editor/react';
import { api } from '../api';
import { languageFor } from '../monaco-setup';
import { parseHunkHeader } from '../diffHunk';
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

  const onMount: DiffOnMount = (editor) => {
    diffEditorRef.current = editor;
  };

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
  if (!pair) return <div className="placeholder">読み込み中...</div>;
  if (pair.binary) return <div className="placeholder">バイナリファイルは差分表示できません</div>;
  if (pair.tooLarge) return <div className="placeholder">ファイルが大きすぎます (2MB 超)</div>;
  if (pair.original === pair.modified) return <div className="placeholder">差分はありません</div>;

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
        <DiffEditor
          original={pair.original}
          modified={pair.modified}
          language={languageFor(path)}
          theme="vs-dark"
          onMount={onMount}
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
      </div>
    </div>
  );
}
