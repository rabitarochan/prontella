// エディターグループツリーのジオメトリ層: react-resizable-panels の再帰描画。
// TileGrid.tsx と同じ「構造キー + defaultSize + onLayoutChanged の
// isUserInteraction ガード」方式。TileGrid と違い portal のコンテンツ層は
// 持たない (設計判断 — Monaco はモデル + viewState 復元で再マウントを生き延びる。
// 実機で分割時のスクロール飛び等が出た場合はここに host-div パターンを閉じて導入する)。

import { Fragment, type JSX } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import type { EditorGroup, GroupNode } from './editorGroups';

export default function GroupSplitView({
  node,
  renderGroup,
  onSizes,
}: {
  node: GroupNode;
  renderGroup: (group: EditorGroup) => JSX.Element;
  onSizes: (splitId: string, sizes: number[]) => void;
}) {
  const render = (n: GroupNode): JSX.Element => {
    if (n.type === 'leaf') return renderGroup(n);
    const separatorClass = n.dir === 'row' ? 'pane-separator-h' : 'pane-separator-v';
    return (
      // Key by structure: adding/removing panels remounts the Group cleanly so
      // defaultSize reapplies from the tree (the single source of truth).
      <Group
        key={`${n.id}:${n.children.map((c) => c.id).join(',')}`}
        orientation={n.dir === 'row' ? 'horizontal' : 'vertical'}
        className="editor-group-grid"
        onLayoutChanged={(layout, meta) => {
          if (!meta.isUserInteraction) return;
          onSizes(
            n.id,
            n.children.map((c) => layout[c.id] ?? 0),
          );
        }}
      >
        {n.children.map((child, i) => (
          <Fragment key={child.id}>
            {i > 0 && <Separator className={`pane-separator ${separatorClass}`} />}
            <Panel
              id={child.id}
              defaultSize={`${n.sizes[i] ?? 100 / n.children.length}%`}
              minSize="120px"
              className="editor-group-panel"
              style={{ overflow: 'hidden' }}
            >
              {render(child)}
            </Panel>
          </Fragment>
        ))}
      </Group>
    );
  };
  return render(node);
}
