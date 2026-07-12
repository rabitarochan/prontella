import { useState } from 'react';
import type { Repo, TerminalSession, Worktree } from '../../types';
import type { LeafNode } from '../../layout/tileTree';
import type { TileActions } from '../../layout/useTileLayout';
import FilesTab from '../FilesTab';
import GitTab from '../GitTab';
import XTermTile from './XTermTile';

/**
 * The actual content of a tile. Rendered through a portal into a stable,
 * detached host element so tree restructures never remount it (which would
 * reconnect the terminal WebSocket / reset Monaco).
 */
export default function TileContentView({
  leaf,
  repo,
  worktree,
  session,
  sessionsLoaded,
  hasFiles,
  hasGit,
  actions,
}: {
  leaf: LeafNode;
  repo: Repo;
  worktree: Worktree;
  session: TerminalSession | null;
  sessionsLoaded: boolean;
  hasFiles: boolean;
  hasGit: boolean;
  actions: TileActions;
}) {
  const [busy, setBusy] = useState(false);
  const content = leaf.content;

  const run = (fn: () => Promise<void>) => {
    setBusy(true);
    void fn().finally(() => setBusy(false));
  };

  if (content.kind === 'files') return <FilesTab root={worktree.path} />;
  if (content.kind === 'git') return <GitTab repo={repo} worktree={worktree} />;

  if (content.kind === 'terminal') {
    if (session) {
      return (
        <div className="tile-terminal">
          <XTermTile key={session.id} id={session.id} claudeMode={session.claudeDetected} />
        </div>
      );
    }
    if (!sessionsLoaded) return <div className="tile-note">接続中…</div>;
    return (
      <div className="tile-note">
        <p>セッションは終了しました</p>
        <div className="tile-picker-buttons">
          <button disabled={busy} onClick={() => run(() => actions.relaunch(leaf.id))}>
            ＋ シェル
          </button>
          <button
            className="claude"
            disabled={busy}
            onClick={() => run(() => actions.relaunch(leaf.id, 'claude'))}
          >
            ✦ Claude 起動
          </button>
          <button disabled={busy} onClick={() => run(() => actions.close(leaf.id))}>
            閉じる
          </button>
        </div>
      </div>
    );
  }

  // empty → picker
  return (
    <div className="tile-note">
      <p>タイルの内容を選択</p>
      <div className="tile-picker-buttons">
        <button disabled={busy} onClick={() => run(() => actions.pick(leaf.id, 'shell'))}>
          ＋ シェル
        </button>
        <button
          className="claude"
          disabled={busy}
          onClick={() => run(() => actions.pick(leaf.id, 'claude'))}
          title="このWorktreeでClaude Codeを起動"
        >
          ✦ Claude 起動
        </button>
        <button
          disabled={busy || hasFiles}
          title={hasFiles ? 'ファイルタイルは 1 枚まで' : undefined}
          onClick={() => run(() => actions.pick(leaf.id, 'files'))}
        >
          ファイル
        </button>
        <button
          disabled={busy || hasGit}
          title={hasGit ? 'Git タイルは 1 枚まで' : undefined}
          onClick={() => run(() => actions.pick(leaf.id, 'git'))}
        >
          Git
        </button>
      </div>
    </div>
  );
}
