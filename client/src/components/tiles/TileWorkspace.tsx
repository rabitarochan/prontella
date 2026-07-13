import { useRef } from 'react';
import type { Repo, TerminalSession, Worktree } from '../../types';
import type { LeafNode, TileView } from '../../layout/tileTree';
import type { TileActions } from '../../layout/useTileLayout';
import FilesTab from '../FilesTab';
import GitTab from '../GitTab';
import TermPanel from '../TermPanel';

/**
 * A tile's tabbed content: files / git / term, switched by the tile header.
 * Rendered through a portal into a stable, detached host element so tree
 * restructures never remount it (which would reconnect terminal WebSockets /
 * reset Monaco).
 *
 * Views mount lazily on first visit and stay mounted afterwards (hidden with
 * display:none) — switching views must not lose editor drafts, diff tabs, or
 * terminal scrollback.
 */
export default function TileWorkspace({
  leaf,
  repo,
  worktree,
  sessions,
  actions,
}: {
  leaf: LeafNode;
  repo: Repo;
  worktree: Worktree;
  sessions: TerminalSession[] | null;
  actions: TileActions;
}) {
  const visitedRef = useRef(new Set<TileView>());
  visitedRef.current.add(leaf.view);
  const visited = visitedRef.current;

  return (
    <div className="tile-workspace">
      {visited.has('files') && (
        <div className="tile-view" style={{ display: leaf.view === 'files' ? undefined : 'none' }}>
          <FilesTab root={worktree.path} />
        </div>
      )}
      {visited.has('git') && (
        <div className="tile-view" style={{ display: leaf.view === 'git' ? undefined : 'none' }}>
          <GitTab repo={repo} worktree={worktree} />
        </div>
      )}
      {visited.has('term') && (
        <div className="tile-view" style={{ display: leaf.view === 'term' ? undefined : 'none' }}>
          <TermPanel
            sessions={sessions}
            ownedIds={leaf.sessions}
            activeId={leaf.activeSession}
            visible={leaf.view === 'term'}
            onActivate={(id) => actions.setActiveSession(leaf.id, id)}
            onCloseTab={(id) => actions.closeSessionTab(leaf.id, id)}
            create={(run) => actions.openTerminal(run, leaf.id)}
          />
        </div>
      )}
    </div>
  );
}
