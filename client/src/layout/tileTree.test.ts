import { describe, expect, it } from 'vitest';
import {
  leaves,
  moveLeaf,
  normalize,
  swapLeaves,
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
