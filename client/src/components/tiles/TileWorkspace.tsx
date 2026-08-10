import { useRef } from 'react';
import type { ActiveRepo, TerminalSession, Worktree } from '../../types';
import { sessionKind } from '../../layout/sessionKinds';
import type { LeafNode, TileView } from '../../layout/tileTree';
import type { TileActions } from '../../layout/useTileLayout';
import ChatPanel from '../ChatPanel';
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
  repo: ActiveRepo;
  worktree: Worktree;
  sessions: TerminalSession[] | null;
  actions: TileActions;
}) {
  const visitedRef = useRef(new Set<TileView>());
  visitedRef.current.add(leaf.view);
  const visited = visitedRef.current;

  return (
    // TileWorkspace is rendered through TileGrid's createPortal (a React sibling of
    // TilePane, not a descendant — React's synthetic events walk the fiber return path,
    // not the DOM tree), so TilePane's own onMouseDownCapture (:74) never sees clicks
    // inside this portal. Duplicate the same capture-phase focus handler here so clicking
    // tile content (FilesTab / GitTab / TermPanel) focuses the leaf too; TilePane's
    // handler stays for header clicks (tabs/split/close), which are outside the portal.
    <div className="tile-workspace" onMouseDownCapture={() => actions.focusLeaf(leaf.id)}>
      {visited.has('files') && (
        <div className="tile-view" style={{ display: leaf.view === 'files' ? undefined : 'none' }}>
          <FilesTab root={worktree.path} leafId={leaf.id} visible={leaf.view === 'files'} />
        </div>
      )}
      {visited.has('git') && (
        <div className="tile-view" style={{ display: leaf.view === 'git' ? undefined : 'none' }}>
          <GitTab repo={repo} worktree={worktree} visible={leaf.view === 'git'} leafId={leaf.id} />
        </div>
      )}
      {visited.has('term') && (
        <div className="tile-view" style={{ display: leaf.view === 'term' ? undefined : 'none' }}>
          <TermPanel
            leafId={leaf.id}
            sessions={sessions}
            ownedIds={leaf.sessions.filter((id) => sessionKind(id) !== 'sdk')}
            activeId={leaf.activeSession}
            visible={leaf.view === 'term'}
            onActivate={(id) => actions.setActiveSession(leaf.id, id)}
            onCloseTab={(id) => actions.closeSessionTab(leaf.id, id)}
            create={(run) => actions.openTerminal(run, leaf.id)}
          />
        </div>
      )}
      {visited.has('chat') && (
        <div className="tile-view" style={{ display: leaf.view === 'chat' ? undefined : 'none' }}>
          <ChatPanel
            leafId={leaf.id}
            root={worktree.path}
            sessions={sessions}
            ownedIds={leaf.sessions.filter((id) => sessionKind(id) === 'sdk')}
            activeId={leaf.activeSession}
            visible={leaf.view === 'chat'}
            onActivate={(id) => actions.setActiveSession(leaf.id, id)}
            onCloseTab={(id) => actions.closeSessionTab(leaf.id, id)}
            create={() => actions.openChat(leaf.id)}
          />
        </div>
      )}
    </div>
  );
}
