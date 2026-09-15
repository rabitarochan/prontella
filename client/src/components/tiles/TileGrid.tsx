import { Fragment, useEffect, useRef, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { Group, Separator } from 'react-resizable-panels';
import { useT } from '../../i18n';
import type { ActiveRepo, TerminalSession, Worktree } from '../../types';
import { collapsedExtent, isMaximized, leaves, type TileNode } from '../../layout/tileTree';
import type { TileActions } from '../../layout/useTileLayout';
import SplitPanel from '../SplitPanel';
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
  // ポータルの描画順は木の走査順に依存させず id で安定ソートする。DnD の
  // スワップ等で leaf の木上の位置が入れ替わっても、ポータル配列の並びが
  // 変わらなければ React の再調停でコンテンツが remount される余地がない
  // (実測: 並び替えを伴う再構成で Monaco が dispose → 再生成されていた)。
  const allLeaves = leaves(root).slice().sort((a, b) => a.id.localeCompare(b.id));

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
          minimized={!!node.minimized}
          maximized={isMaximized(root, node.id)}
          actions={actions}
          host={getHost(node.id)}
        />
      );
    }
    const separatorClass =
      node.dir === 'row' ? 'pane-separator-h' : 'pane-separator-v';
    // 畳まれた子は px 固定、展開中の子は defaultSize を渡さず「残りを等分」で
    // 受け取らせる。px と % を兄弟で混ぜると既定レイアウトの正規化で両方が縮む。
    // ponytail: 畳んでいるあいだ、展開中の兄弟が 2 枚以上あるとその比率は等分に
    // なる (復元すれば木の sizes から戻る)。比率を保つには Group の実寸 px を
    // 測って % を自前計算するしかなく、それは display:none 下で 0 になる測定に
    // 依存する。実害が出たらそこで初めて測定込みの実装へ上げる。
    const extents = node.children.map((c) => collapsedExtent(c, node.dir));
    const anyCollapsed = extents.some((e) => e !== null);
    return (
      // Key by structure: adding/removing panels remounts the Group cleanly so
      // the sizes reapply from the tree (the single source of truth). This is
      // also why SplitPanel may freeze its defaultSize — see SplitPanel.tsx.
      <Group
        key={`${node.id}:${node.children.map((c) => c.id).join(',')}`}
        orientation={node.dir === 'row' ? 'horizontal' : 'vertical'}
        className="tile-group"
        onLayoutChanged={(layout, meta) => {
          if (!meta.isUserInteraction) return;
          // 畳んでいるあいだのドラッグは書き戻さない。木に残った畳む前の比率が
          // そのまま「復元したときのサイズ」になる (復元用の state を持たずに済む)。
          if (anyCollapsed) return;
          actions.applySizes(
            node.id,
            node.children.map((c) => layout[c.id] ?? 0),
          );
        }}
      >
        {node.children.map((child, i) => (
          <Fragment key={child.id}>
            {i > 0 && <Separator className={`pane-separator ${separatorClass}`} />}
            <SplitPanel
              id={child.id}
              fixedPx={extents[i] ?? undefined}
              initialSize={
                extents[i] !== null || anyCollapsed
                  ? undefined
                  : `${node.sizes[i] ?? 100 / node.children.length}%`
              }
              className="tile-panel"
            >
              {renderNode(child)}
            </SplitPanel>
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
