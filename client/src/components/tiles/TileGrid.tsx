import { Fragment, useEffect, useRef, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { useT } from '../../i18n';
import type { ActiveRepo, TerminalSession, Worktree } from '../../types';
import { leaves, type TileNode } from '../../layout/tileTree';
import type { TileActions } from '../../layout/useTileLayout';
import TilePane from './TilePane';
import TileWorkspace from './TileWorkspace';

/**
 * Two-layer rendering:
 * - Geometry layer: recursive Group/Panel/Separator + TilePane chrome. This
 *   layer is freely remounted when the tree structure changes.
 * - Content layer: one portal per leaf into a stable detached host div (kept
 *   in hostsRef). The portal's container and key never change for the life of
 *   a leaf, so the workspace (FilesTab / GitTab / TermPanel) is never
 *   remounted by splits or closes elsewhere — TilePane just re-appends the
 *   host DOM node.
 */
export default function TileGrid({
  repo,
  worktree,
  sessions,
  actions,
}: {
  repo: ActiveRepo;
  worktree: Worktree;
  sessions: TerminalSession[] | null;
  actions: TileActions;
}) {
  const t = useT();
  const hostsRef = useRef(new Map<string, HTMLDivElement>());
  const getHost = (id: string): HTMLDivElement => {
    let el = hostsRef.current.get(id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'tile-host';
      hostsRef.current.set(id, el);
    }
    return el;
  };

  const root = actions.layout.root;
  const allLeaves = leaves(root);

  // Drop hosts whose leaf is gone (their portal unmounts in the same commit).
  useEffect(() => {
    const alive = new Set(allLeaves.map((l) => l.id));
    for (const [id, el] of hostsRef.current) {
      if (!alive.has(id)) {
        el.remove();
        hostsRef.current.delete(id);
      }
    }
  });

  const renderNode = (node: TileNode): JSX.Element => {
    if (node.type === 'leaf') {
      return (
        <TilePane
          leaf={node}
          sessions={sessions}
          focused={actions.focusedLeafId === node.id}
          actions={actions}
          host={getHost(node.id)}
        />
      );
    }
    const separatorClass =
      node.dir === 'row' ? 'pane-separator-h' : 'pane-separator-v';
    return (
      // Key by structure: adding/removing panels remounts the Group cleanly so
      // defaultSize reapplies from the tree (the single source of truth).
      <Group
        key={`${node.id}:${node.children.map((c) => c.id).join(',')}`}
        orientation={node.dir === 'row' ? 'horizontal' : 'vertical'}
        className="tile-group"
        onLayoutChanged={(layout, meta) => {
          if (!meta.isUserInteraction) return;
          actions.applySizes(
            node.id,
            node.children.map((c) => layout[c.id] ?? 0),
          );
        }}
      >
        {node.children.map((child, i) => (
          <Fragment key={child.id}>
            {i > 0 && <Separator className={`pane-separator ${separatorClass}`} />}
            <Panel
              id={child.id}
              defaultSize={`${node.sizes[i] ?? 100 / node.children.length}%`}
              minSize="120px"
              className="tile-panel"
              style={{ overflow: 'hidden' }}
            >
              {renderNode(child)}
            </Panel>
          </Fragment>
        ))}
      </Group>
    );
  };

  return (
    <div className="tile-grid">
      {root ? (
        renderNode(root)
      ) : (
        <div className="tile-note">
          <p>{t('tile.empty')}</p>
          <div className="tile-picker-buttons">
            <button onClick={() => void actions.openTerminal()}>{t('term.newShellButton')}</button>
            <button
              className="claude"
              onClick={() => void actions.openTerminal('claude')}
              title={t('term.launchClaudeTitle')}
            >
              {t('term.launchClaudeButton')}
            </button>
            <button onClick={() => actions.reset()}>{t('tile.resetLayout')}</button>
          </div>
        </div>
      )}
      {allLeaves.map((leaf) =>
        createPortal(
          <TileWorkspace
            leaf={leaf}
            repo={repo}
            worktree={worktree}
            sessions={sessions}
            actions={actions}
          />,
          getHost(leaf.id),
          leaf.id,
        ),
      )}
    </div>
  );
}
