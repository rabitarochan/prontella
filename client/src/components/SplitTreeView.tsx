// 分割ツリーのジオメトリ層: react-resizable-panels の再帰描画。リーフの
// ペイロード型に依存しないので、エディターグループ (components/files/
// GroupSplitView.tsx) とターミナルグループ (components/term/TermGroupPane を
// 束ねる TermPanel) の両方がこれを使う。
//
// TileGrid.tsx と同じ「構造キー + initialSize + onLayoutChanged の
// isUserInteraction ガード」方式 — サイズの単一真理は常に木の側で、
// ユーザーのドラッグ以外では木へ書き戻さない。
//
// このコンポーネントは portal のコンテンツ層を持たない。リーフの中身が
// 再マウントに耐えられない場合 (xterm 等) は、呼び出し側が TileGrid と同じ
// host-div + createPortal を自前で用意すること。

import { Fragment, type JSX } from 'react';
import { Group, Separator } from 'react-resizable-panels';
import type { LeafBase, NodeOf } from '../layout/splitTree';
import SplitPanel from './SplitPanel';

export default function SplitTreeView<L extends LeafBase>({
  node,
  gridClass,
  panelClass,
  renderLeaf,
  onSizes,
}: {
  node: NodeOf<L>;
  /** 分割コンテナ (Group) に付けるクラス */
  gridClass: string;
  /** 各ペイン (SplitPanel) に付けるクラス */
  panelClass: string;
  renderLeaf: (leaf: L) => JSX.Element;
  onSizes: (splitId: string, sizes: number[]) => void;
}) {
  const render = (n: NodeOf<L>): JSX.Element => {
    if (n.type === 'leaf') return renderLeaf(n);
    const separatorClass = n.dir === 'row' ? 'pane-separator-h' : 'pane-separator-v';
    return (
      // Key by structure: adding/removing panels remounts the Group cleanly so
      // the sizes reapply from the tree (the single source of truth). This is
      // also why SplitPanel may freeze its defaultSize — see SplitPanel.tsx.
      <Group
        key={`${n.id}:${n.children.map((c) => c.id).join(',')}`}
        orientation={n.dir === 'row' ? 'horizontal' : 'vertical'}
        className={gridClass}
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
            <SplitPanel
              id={child.id}
              initialSize={`${n.sizes[i] ?? 100 / n.children.length}%`}
              className={panelClass}
            >
              {render(child)}
            </SplitPanel>
          </Fragment>
        ))}
      </Group>
    );
  };
  return render(node);
}
