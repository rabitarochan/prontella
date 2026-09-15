import { describe, expect, it } from 'vitest';
import {
  COLLAPSED_PX,
  collapsedExtent,
  equalize,
  isMaximized,
  leaves,
  maximizeLeaf,
  moveLeaf,
  normalize,
  restoreAll,
  swapLeaves,
  toggleMinimize,
  type LeafNode,
  type SplitNode,
  type TileNode,
} from './tileTree';

function leaf(id: string): LeafNode {
  return { type: 'leaf', id, view: 'term', sessions: [], activeSession: null };
}

function split(id: string, dir: 'row' | 'column', children: TileNode[]): SplitNode {
  return { type: 'split', id, dir, sizes: children.map(() => 100 / children.length), children };
}

const ids = (node: TileNode | null) => leaves(node).map((l) => l.id);

describe('moveLeaf', () => {
  it('別方向への移動は対象を新しい 50/50 split で包む', () => {
    // row[A,B] で A を B の下へ → B を column で包み [B,A]
    const root = split('s1', 'row', [leaf('A'), leaf('B')]);
    const moved = moveLeaf(root, 'A', 'B', 'column', false);
    expect(moved.type).toBe('split');
    const s = moved as SplitNode;
    expect(s.dir).toBe('column');
    expect(ids(s)).toEqual(['B', 'A']);
    expect(s.sizes).toEqual([50, 50]);
  });

  it('before=true は対象の前へ挿入する', () => {
    const root = split('s1', 'row', [leaf('A'), leaf('B')]);
    const moved = moveLeaf(root, 'A', 'B', 'column', true);
    expect(ids(moved)).toEqual(['A', 'B']);
    expect((moved as SplitNode).dir).toBe('column');
  });

  it('同方向 split には平坦に挿入し、対象のサイズを折半する', () => {
    // row[A,B,C] で C を A の前へ → row[C,A,B]
    const root = split('s1', 'row', [leaf('A'), leaf('B'), leaf('C')]);
    const moved = moveLeaf(root, 'C', 'A', 'row', true) as SplitNode;
    expect(moved.dir).toBe('row');
    expect(ids(moved)).toEqual(['C', 'A', 'B']);
    // C を除去した時点で A,B が renormalize され 50/50、A の 50 を C と折半
    expect(moved.sizes[0]).toBeCloseTo(25);
    expect(moved.sizes[1]).toBeCloseTo(25);
    expect(moved.sizes[2]).toBeCloseTo(50);
    expect(moved.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(100);
  });

  it('移動元の親 split が単子になったら畳み込まれる', () => {
    // column[ row[A,B], C ] で A を C の右へ → column[ B, row?[C,A] ] (row は消える)
    const root = split('s1', 'column', [split('s2', 'row', [leaf('A'), leaf('B')]), leaf('C')]);
    const moved = moveLeaf(root, 'A', 'C', 'row', false);
    expect(ids(moved)).toEqual(['B', 'C', 'A']);
    const top = moved as SplitNode;
    expect(top.dir).toBe('column');
    expect(top.children[0].type).toBe('leaf'); // 旧 row[A,B] は leaf B に畳まれた
    const inner = top.children[1] as SplitNode;
    expect(inner.dir).toBe('row');
    expect(ids(inner)).toEqual(['C', 'A']);
  });

  it('セッション情報ごと移動する', () => {
    const a: LeafNode = { ...leaf('A'), sessions: ['x', 'y'], activeSession: 'y' };
    const root = split('s1', 'row', [a, leaf('B')]);
    const moved = moveLeaf(root, 'A', 'B', 'column', false);
    const movedA = leaves(moved).find((l) => l.id === 'A')!;
    expect(movedA.sessions).toEqual(['x', 'y']);
    expect(movedA.activeSession).toBe('y');
  });

  it('src === target / 不在 id / 単一 leaf では no-op', () => {
    const root = split('s1', 'row', [leaf('A'), leaf('B')]);
    expect(moveLeaf(root, 'A', 'A', 'row', false)).toBe(root);
    expect(moveLeaf(root, 'Z', 'B', 'row', false)).toBe(root);
    expect(moveLeaf(root, 'A', 'Z', 'row', false)).toBe(root);
    const single = leaf('A');
    expect(moveLeaf(single, 'A', 'A', 'row', false)).toBe(single);
  });

  it('normalize 後もサイズ合計が 100 のまま', () => {
    const root = split('s1', 'row', [leaf('A'), leaf('B'), leaf('C')]);
    const moved = normalize(moveLeaf(root, 'A', 'C', 'column', false)) as SplitNode;
    const sum = (n: TileNode): void => {
      if (n.type !== 'split') return;
      expect(n.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(100);
      n.children.forEach(sum);
    };
    sum(moved);
  });
});

describe('swapLeaves', () => {
  it('2 つの leaf の位置を入れ替える (id・セッションは保持)', () => {
    const a: LeafNode = { ...leaf('A'), sessions: ['x'], activeSession: 'x' };
    const root = split('s1', 'column', [split('s2', 'row', [a, leaf('B')]), leaf('C')]);
    const swapped = swapLeaves(root, 'A', 'C') as SplitNode;
    expect(ids(swapped)).toEqual(['C', 'B', 'A']);
    const movedA = leaves(swapped).find((l) => l.id === 'A')!;
    expect(movedA.sessions).toEqual(['x']);
    // 構造は不変 (split の形は同じ)
    expect(swapped.dir).toBe('column');
    expect((swapped.children[0] as SplitNode).dir).toBe('row');
  });

  it('同一 id / 不在 id では no-op', () => {
    const root = split('s1', 'row', [leaf('A'), leaf('B')]);
    expect(swapLeaves(root, 'A', 'A')).toBe(root);
    expect(swapLeaves(root, 'A', 'Z')).toBe(root);
  });
});

// ---- 最小化 / 最大化 / 均等割り -------------------------------------------

function minLeaf(id: string): LeafNode {
  return { ...leaf(id), minimized: true };
}

/** 木に現れる split の id を出現順で集める (id が振り直されたかの判定用)。 */
function splitIds(node: TileNode): string[] {
  if (node.type === 'leaf') return [];
  return [node.id, ...node.children.flatMap(splitIds)];
}

describe('equalize', () => {
  it('入れ子の全 split を等分にし、split の id だけ振り直す', () => {
    const inner: SplitNode = {
      type: 'split',
      id: 's2',
      dir: 'row',
      sizes: [80, 20],
      children: [leaf('B'), leaf('C')],
    };
    const root: SplitNode = {
      type: 'split',
      id: 's1',
      dir: 'column',
      sizes: [62, 38],
      children: [leaf('A'), inner],
    };

    const out = equalize(root) as SplitNode;
    expect(out.sizes).toEqual([50, 50]);
    expect((out.children[1] as SplitNode).sizes).toEqual([50, 50]);
    // leaf の id は不変 (= コンテンツのポータルは remount しない)
    expect(ids(out)).toEqual(['A', 'B', 'C']);
    // split の id は全て別物 (= Group が再マウントされ、凍結 defaultSize が読み直される)
    expect(splitIds(out)).toHaveLength(2);
    for (const id of splitIds(out)) expect(['s1', 's2']).not.toContain(id);
  });

  it('畳まれていたタイルも展開する', () => {
    const root = split('s1', 'row', [minLeaf('A'), leaf('B')]);
    const out = equalize(root);
    expect(leaves(out).map((l) => l.minimized)).toEqual([undefined, undefined]);
  });
});

describe('collapsedExtent', () => {
  it('展開中の leaf があれば null、畳まれた leaf は軸に関係なく COLLAPSED_PX', () => {
    expect(collapsedExtent(leaf('A'), 'row')).toBeNull();
    expect(collapsedExtent(minLeaf('A'), 'row')).toBe(COLLAPSED_PX);
    expect(collapsedExtent(minLeaf('A'), 'column')).toBe(COLLAPSED_PX);
  });

  it('一部だけ畳まれた split は null (通常どおり % で配分する)', () => {
    const s = split('s1', 'column', [minLeaf('A'), leaf('B')]);
    expect(collapsedExtent(s, 'column')).toBeNull();
    expect(collapsedExtent(s, 'row')).toBeNull();
  });

  it('全部畳まれた split は 軸と同方向なら和、直交なら最大値', () => {
    const s = split('s1', 'column', [minLeaf('A'), minLeaf('B')]);
    // column の split を縦に測る = 2 段積み上がる
    expect(collapsedExtent(s, 'column')).toBe(COLLAPSED_PX * 2);
    // 同じものを横に測る = 縦レール 1 本ぶんの幅
    expect(collapsedExtent(s, 'row')).toBe(COLLAPSED_PX);
  });

  it('入れ子でも軸に沿って畳まれる', () => {
    // row[ A, column[B, C] ] の右枝を横方向に測ると 1 本ぶん
    const branch = split('s2', 'column', [minLeaf('B'), minLeaf('C')]);
    const root = split('s1', 'row', [leaf('A'), branch]);
    expect(collapsedExtent(root.children[1], 'row')).toBe(COLLAPSED_PX);
    expect(collapsedExtent(root, 'row')).toBeNull(); // A が展開中
  });
});

describe('maximizeLeaf / restoreAll / toggleMinimize', () => {
  const tree = () =>
    split('s1', 'row', [leaf('A'), split('s2', 'column', [leaf('B'), leaf('C')])]);

  it('最大化は対象以外を全て畳み、isMaximized が対象にだけ true を返す', () => {
    const out = maximizeLeaf(tree(), 'A');
    expect(leaves(out).map((l) => [l.id, !!l.minimized])).toEqual([
      ['A', false],
      ['B', true],
      ['C', true],
    ]);
    expect(isMaximized(out, 'A')).toBe(true);
    expect(isMaximized(out, 'B')).toBe(false);
    // split の id が振り直されている (Group 再マウントのトリガー)
    expect(splitIds(out)).not.toEqual(['s1', 's2']);
  });

  it('restoreAll で全て展開に戻る', () => {
    const out = restoreAll(maximizeLeaf(tree(), 'A'));
    expect(leaves(out).every((l) => l.minimized === undefined)).toBe(true);
    expect(isMaximized(out, 'A')).toBe(false);
  });

  it('leaf が 1 枚だけの木では最大化は成立しない', () => {
    expect(isMaximized(leaf('A'), 'A')).toBe(false);
  });

  it('展開中が 0 枚になる最小化は no-op', () => {
    const maxed = maximizeLeaf(tree(), 'A');
    expect(toggleMinimize(maxed, 'A')).toBe(maxed);
    // 畳まれている側の解除は通る
    expect(leaves(toggleMinimize(maxed, 'B')).find((l) => l.id === 'B')?.minimized).toBeUndefined();
  });

  it('不在 id では no-op', () => {
    const root = tree();
    expect(toggleMinimize(root, 'Z')).toBe(root);
    expect(maximizeLeaf(root, 'Z')).toBe(root);
  });
});
