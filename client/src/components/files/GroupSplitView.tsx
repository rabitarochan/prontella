// エディターグループツリーのジオメトリ層。中身は汎用の SplitTreeView
// (components/SplitTreeView.tsx) — ここはクラス名を束ねる薄いラッパー。
//
// TileGrid と違い portal のコンテンツ層は持たない (設計判断 — Monaco はモデル +
// viewState 復元で再マウントを生き延びる。実機で分割時のスクロール飛び等が出た
// 場合はここに host-div パターンを閉じて導入する)。

import { type JSX } from 'react';
import SplitTreeView from '../SplitTreeView';
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
  return (
    <SplitTreeView<EditorGroup>
      node={node}
      gridClass="editor-group-grid"
      panelClass="editor-group-panel"
      renderLeaf={renderGroup}
      onSizes={onSizes}
    />
  );
}
