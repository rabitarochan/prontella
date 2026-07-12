import { Fragment, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Group, Panel, Separator } from 'react-resizable-panels';
import type { Repo, TerminalSession, Worktree } from '../../types';
import { leaves, type LeafNode, type TileNode } from '../../layout/tileTree';
import type { TileActions } from '../../layout/useTileLayout';
import TilePane from './TilePane';
import TileContentView from './TileContentView';

/**
 * Two-layer rendering:
 * - Geometry layer: recursive Group/Panel/Separator + TilePane chrome. This
 *   layer is freely remounted when the tree structure changes.
 * - Content layer: one portal per leaf into a stable detached host div (kept
 *   in hostsRef). The portal's container and key never change for the life of
 *   a leaf, so FilesTab / GitTab / XTermTile are never remounted by splits or
 *   closes elsewhere — TilePane just re-appends the host DOM node.
 */
export default function TileGrid({
  repo,
  worktree,
  sessions,
  actions,
}: {
  repo: Repo;
  worktree: Worktree;
  sessions: TerminalSession[] | null;
  actions: TileActions;
}) {
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

  const hasFiles = allLeaves.some((l) => l.content.kind === 'files');
  const hasGit = allLeaves.some((l) => l.content.kind === 'git');

  const sessionOf = (leaf: LeafNode): TerminalSession | null =>
    leaf.content.kind === 'terminal'
      ? (sessions?.find(
          (s) => leaf.content.kind === 'terminal' && s.id === leaf.content.sessionId,
        ) ?? null)
      : null;

  const renderNode = (node: TileNode): JSX.Element => {
    if (node.type === 'leaf') {
      return (
        <TilePane
          leaf={node}
          session={sessionOf(node)}
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
              minSize="80px"
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
          <p>タイルがありません</p>
          <div className="tile-picker-buttons">
            <button onClick={() => void actions.openTerminal()}>＋ シェル</button>
            <button
              className="claude"
              onClick={() => void actions.openTerminal('claude')}
              title="このWorktreeでClaude Codeを起動"
            >
              ✦ Claude 起動
            </button>
            <button onClick={() => actions.openContent('files')}>ファイル</button>
            <button onClick={() => actions.openContent('git')}>Git</button>
          </div>
        </div>
      )}
      {allLeaves.map((leaf) =>
        createPortal(
          <TileContentView
            leaf={leaf}
            repo={repo}
            worktree={worktree}
            session={sessionOf(leaf)}
            sessionsLoaded={sessions !== null}
            hasFiles={hasFiles}
            hasGit={hasGit}
            actions={actions}
          />,
          getHost(leaf.id),
          leaf.id,
        ),
      )}
    </div>
  );
}
