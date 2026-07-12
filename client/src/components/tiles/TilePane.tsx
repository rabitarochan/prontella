import type { TerminalSession } from '../../types';
import type { LeafNode } from '../../layout/tileTree';
import type { TileActions } from '../../layout/useTileLayout';
import StatusBadge from '../StatusBadge';

const META: Record<string, { title: string; icon: string }> = {
  files: { title: 'ファイル', icon: 'codicon-files' },
  git: { title: 'Git', icon: 'codicon-source-control' },
  terminal: { title: 'ターミナル', icon: 'codicon-terminal' },
  empty: { title: '新しいタイル', icon: 'codicon-add' },
};

/**
 * Tile chrome: header with title/status/split/close, and a body that adopts
 * the leaf's stable host element. TilePane itself may be remounted freely by
 * geometry changes — appendChild of the already-parented host is just a move.
 */
export default function TilePane({
  leaf,
  session,
  focused,
  actions,
  host,
}: {
  leaf: LeafNode;
  session: TerminalSession | null;
  focused: boolean;
  actions: TileActions;
  host: HTMLDivElement;
}) {
  const meta = META[leaf.content.kind];
  const title = leaf.content.kind === 'terminal' ? (session?.title ?? 'ターミナル') : meta.title;

  return (
    <section
      className={`tile-pane ${focused ? 'focused' : ''}`}
      onMouseDownCapture={() => actions.focusLeaf(leaf.id)}
    >
      <header className="tile-header">
        <span className={`codicon ${meta.icon}`} />
        <span className="tile-title">{title}</span>
        {leaf.content.kind === 'terminal' && session && (
          <StatusBadge status={session.status} compact />
        )}
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
          <button className="icon-btn" title="閉じる" onClick={() => void actions.close(leaf.id)}>
            <span className="codicon codicon-close" />
          </button>
        </span>
      </header>
      <div
        className="tile-body"
        ref={(el) => {
          if (el) el.appendChild(host);
        }}
      />
    </section>
  );
}
