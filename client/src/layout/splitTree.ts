// Generic split-tree structure ops, shared by the tile layout (tileTree.ts)
// and the editor-group layout inside a files panel (components/files/
// editorGroups.ts). Pure data + pure operations, no React. Only the leaf
// payload differs between the two trees, so the payload type is generic and
// just the structural invariants live here:
// - a split's children.length >= 2 after normalize (single-child splits collapse)
// - sizes are percentages summing to 100, same length as children

export type SplitDir = 'row' | 'column';

export interface LeafBase {
  type: 'leaf';
  id: string;
}

export interface SplitOf<L extends LeafBase> {
  type: 'split';
  id: string;
  dir: SplitDir;
  /** percentages, same length as children */
  sizes: number[];
  /** invariant after normalize: length >= 2 */
  children: NodeOf<L>[];
}

export type NodeOf<L extends LeafBase> = L | SplitOf<L>;

export function newId(): string {
  return crypto.randomUUID().slice(0, 8);
}

export function equalSizes(n: number): number[] {
  return Array.from({ length: n }, () => 100 / n);
}

export function renormalized(sizes: number[]): number[] {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return equalSizes(sizes.length);
  return sizes.map((s) => (s / total) * 100);
}

/** All leaves in stable tree order. */
export function leavesOf<L extends LeafBase>(node: NodeOf<L> | null): L[] {
  if (!node) return [];
  if (node.type === 'leaf') return [node];
  return node.children.flatMap((c) => leavesOf(c));
}

export function findLeafOf<L extends LeafBase>(node: NodeOf<L> | null, leafId: string): L | null {
  return leavesOf(node).find((l) => l.id === leafId) ?? null;
}

export function updateLeafOf<L extends LeafBase>(
  root: NodeOf<L>,
  leafId: string,
  patch: (leaf: L) => L,
): NodeOf<L> {
  const rec = (node: NodeOf<L>): NodeOf<L> => {
    if (node.type === 'leaf') return node.id === leafId ? patch(node) : node;
    return { ...node, children: node.children.map(rec) };
  };
  return rec(root);
}

/**
 * Insert `leaf` beside the leaf `targetLeafId` in direction `dir`: if the
 * target's parent already splits in `dir`, the leaf is inserted as a sibling
 * (taking half of the target's share); otherwise the target is wrapped into a
 * new 50/50 split. Returns the tree unchanged when the target is missing.
 */
export function insertBesideLeaf<L extends LeafBase>(
  root: NodeOf<L>,
  targetLeafId: string,
  dir: SplitDir,
  before: boolean,
  leaf: L,
  makeSplitId: () => string = newId,
): NodeOf<L> {
  const rec = (node: NodeOf<L>): NodeOf<L> => {
    if (node.type === 'leaf') {
      if (node.id !== targetLeafId) return node;
      const children: NodeOf<L>[] = before ? [leaf, node] : [node, leaf];
      return { type: 'split', id: makeSplitId(), dir, sizes: [50, 50], children };
    }
    const idx = node.children.findIndex((c) => c.type === 'leaf' && c.id === targetLeafId);
    if (idx >= 0 && node.dir === dir) {
      const children = [...node.children];
      const sizes = [...node.sizes];
      const half = (sizes[idx] ?? 100 / node.children.length) / 2;
      sizes[idx] = half;
      const at = before ? idx : idx + 1;
      children.splice(at, 0, leaf);
      sizes.splice(at, 0, half);
      return { ...node, children, sizes };
    }
    return { ...node, children: node.children.map(rec) };
  };
  return rec(root);
}

/** Remove a leaf; collapses now-single-child splits. Returns null when empty. */
export function removeLeafOf<L extends LeafBase>(
  root: NodeOf<L>,
  leafId: string,
): NodeOf<L> | null {
  const rec = (node: NodeOf<L>): NodeOf<L> | null => {
    if (node.type === 'leaf') return node.id === leafId ? null : node;
    const children: NodeOf<L>[] = [];
    const sizes: number[] = [];
    node.children.forEach((c, i) => {
      const r = rec(c);
      if (r) {
        children.push(r);
        sizes.push(node.sizes[i] ?? 100 / node.children.length);
      }
    });
    if (children.length === 0) return null;
    if (children.length === 1) return children[0];
    return { ...node, children, sizes: renormalized(sizes) };
  };
  return rec(root);
}

export function setSizesOf<L extends LeafBase>(
  root: NodeOf<L>,
  splitId: string,
  sizes: number[],
): NodeOf<L> {
  const rec = (node: NodeOf<L>): NodeOf<L> => {
    if (node.type === 'leaf') return node;
    if (node.id === splitId && sizes.length === node.children.length) {
      return { ...node, sizes: [...sizes] };
    }
    return { ...node, children: node.children.map(rec) };
  };
  return rec(root);
}

/** Collapse single-child splits and merge same-direction nesting. */
export function normalizeOf<L extends LeafBase>(node: NodeOf<L> | null): NodeOf<L> | null {
  if (!node || node.type === 'leaf') return node;
  const children: NodeOf<L>[] = [];
  const sizes: number[] = [];
  node.children.forEach((c, i) => {
    const n = normalizeOf(c);
    if (!n) return;
    const slot = node.sizes[i] ?? 100 / node.children.length;
    if (n.type === 'split' && n.dir === node.dir) {
      n.children.forEach((gc, j) => {
        children.push(gc);
        sizes.push(((n.sizes[j] ?? 100 / n.children.length) * slot) / 100);
      });
    } else {
      children.push(n);
      sizes.push(slot);
    }
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return { ...node, children, sizes: renormalized(sizes) };
}
