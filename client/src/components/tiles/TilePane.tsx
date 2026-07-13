import { useCallback, useEffect } from 'react';
import type { AgentStatus, TerminalSession } from '../../types';
import type { LeafNode, TileView } from '../../layout/tileTree';
import type { TileActions } from '../../layout/useTileLayout';
import StatusBadge from '../StatusBadge';

const VIEWS: { view: TileView; label: string; icon: string }[] = [
  { view: 'files', label: 'ファイル', icon: 'codicon-files' },
  { view: 'git', label: 'Git', icon: 'codicon-source-control' },
  { view: 'term', label: 'ターミナル', icon: 'codicon-terminal' },
];

/** タイル内セッションの「最も注意が必要な」ステータス (デッキのカードと同じ優先順)。 */
function aggregateStatus(leaf: LeafNode, sessions: TerminalSession[] | null): AgentStatus | null {
  const owned = (sessions ?? []).filter((s) => leaf.sessions.includes(s.id));
  if (owned.length === 0) return null;
  const order: AgentStatus[] = ['waiting', 'busy', 'idle', 'shell'];
  for (const status of order) {
    if (owned.some((s) => s.status === status)) return status;
  }
  return null;
}

/**
 * Tile chrome: the header IS the tile's top-level tab bar (files / git /
 * term) plus split/close actions. The body adopts the leaf's stable host
 * element. TilePane itself may be remounted freely by geometry changes —
 * appendChild of the already-parented host is just a move.
 */
export default function TilePane({
  leaf,
  sessions,
  focused,
  actions,
  host,
}: {
  leaf: LeafNode;
  sessions: TerminalSession[] | null;
  focused: boolean;
  actions: TileActions;
  host: HTMLDivElement;
}) {
  // A DOM move (host re-append after a split/close elsewhere) drops focus;
  // give it back to the focused terminal. Mount-only: focus changes from
  // clicks are handled by the browser itself.
  useEffect(() => {
    if (focused) host.querySelector('textarea')?.focus();
  }, []);

  // Adopt the host node. Must be idempotent: appendChild detaches and
  // re-inserts even under the same parent, which silently drops focus and
  // selection — guard so re-renders (e.g. the 3s status poll) are no-ops.
  const adoptHost = useCallback(
    (el: HTMLDivElement | null) => {
      if (el && host.parentElement !== el) el.appendChild(host);
    },
    [host],
  );

  const close = () => {
    // FilesTab marks unsaved tabs with .editor-tab-dirty — closing the tile
    // would silently discard those drafts.
    if (host.querySelector('.editor-tab-dirty')) {
      if (!confirm('未保存の変更があります。タイルを閉じますか?')) return;
    }
    void actions.close(leaf.id);
  };

  const termStatus = aggregateStatus(leaf, sessions);

  return (
    <section
      className={`tile-pane ${focused ? 'focused' : ''}`}
      onMouseDownCapture={() => actions.focusLeaf(leaf.id)}
    >
      <header className="tile-header">
        <span className="tile-tabs">
          {VIEWS.map(({ view, label, icon }) => (
            <button
              key={view}
              className={`tile-tab ${leaf.view === view ? 'active' : ''}`}
              title={label}
              onClick={() => actions.setView(leaf.id, view)}
            >
              <span className={`codicon ${icon}`} />
              <span className="tile-tab-label">{label}</span>
              {view === 'term' && leaf.sessions.length > 0 && (
                <span className="tile-tab-count">{leaf.sessions.length}</span>
              )}
              {view === 'term' && termStatus && <StatusBadge status={termStatus} compact />}
            </button>
          ))}
        </span>
        <span className="tile-actions">
          <button
            className="icon-btn"
            title="右に分割"
            onClick={() => actions.split(leaf.id, 'row')}
          >
            <span className="codicon codicon-split-horizontal" />
          </button>
          <button
            className="icon-btn"
            title="下に分割"
            onClick={() => actions.split(leaf.id, 'column')}
          >
            <span className="codicon codicon-split-vertical" />
          </button>
          <button className="icon-btn" title="タイルを閉じる" onClick={close}>
            <span className="codicon codicon-close" />
          </button>
        </span>
      </header>
      <div className="tile-body" ref={adoptHost} />
    </section>
  );
}
