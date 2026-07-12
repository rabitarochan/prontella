// Tile layout tree: pure data + pure operations, no React.
// A layout is a tree of splits (row = side by side, column = stacked)
// whose leaves host a content: the files tab, the git tab, one terminal
// session, or an empty picker.

export type TileContent =
  | { kind: 'files' }
  | { kind: 'git' }
  | { kind: 'terminal'; sessionId: string }
  | { kind: 'empty' };

export interface LeafNode {
  type: 'leaf';
  id: string;
  content: TileContent;
}

export interface SplitNode {
  type: 'split';
  id: string;
  dir: 'row' | 'column';
  /** percentages, same length as children */
  sizes: number[];
  /** invariant after normalize: length >= 2 */
  children: TileNode[];
}

export type TileNode = LeafNode | SplitNode;

export interface WorktreeLayout {
  version: 1;
  root: TileNode | null;
}

export function newId(): string {
  return crypto.randomUUID().slice(0, 8);
}

export function makeLeaf(content: TileContent): LeafNode {
  return { type: 'leaf', id: newId(), content };
}

/** Reproduces the pre-tile look: files on top, terminal area below. */
export function createDefaultLayout(): WorktreeLayout {
  return {
    version: 1,
    root: {
      type: 'split',
      id: newId(),
      dir: 'column',
      sizes: [62, 38],
      children: [makeLeaf({ kind: 'files' }), makeLeaf({ kind: 'empty' })],
    },
  };
}

/** All leaves in stable tree order. */
export function leaves(node: TileNode | null): LeafNode[] {
  if (!node) return [];
  if (node.type === 'leaf') return [node];
  return node.children.flatMap(leaves);
}

export function findLeaf(node: TileNode | null, leafId: string): LeafNode | null {
  return leaves(node).find((l) => l.id === leafId) ?? null;
}

function equalSizes(n: number): number[] {
  return Array.from({ length: n }, () => 100 / n);
}

function renormalized(sizes: number[]): number[] {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return equalSizes(sizes.length);
  return sizes.map((s) => (s / total) * 100);
}

/**
 * Split `leafId` in direction `dir`, placing a new leaf with `content`
 * after it. If the leaf's parent already splits in `dir`, the new leaf is
 * inserted as a sibling (taking half of the target's share); otherwise the
 * leaf is wrapped into a new 50/50 split.
 */
export function splitLeaf(
  root: TileNode,
  leafId: string,
  dir: 'row' | 'column',
  content: TileContent,
): { root: TileNode; newLeafId: string } {
  const newLeaf = makeLeaf(content);

  const rec = (node: TileNode): TileNode => {
    if (node.type === 'leaf') {
      if (node.id !== leafId) return node;
      return { type: 'split', id: newId(), dir, sizes: [50, 50], children: [node, newLeaf] };
    }
    const idx = node.children.findIndex((c) => c.type === 'leaf' && c.id === leafId);
    if (idx >= 0 && node.dir === dir) {
      const children = [...node.children];
      children.splice(idx + 1, 0, newLeaf);
      const sizes = [...node.sizes];
      const half = (sizes[idx] ?? 100 / node.children.length) / 2;
      sizes[idx] = half;
      sizes.splice(idx + 1, 0, half);
      return { ...node, children, sizes };
    }
    return { ...node, children: node.children.map(rec) };
  };

  return { root: rec(root), newLeafId: newLeaf.id };
}

/** Remove a leaf; collapses now-single-child splits. Returns null when empty. */
export function removeLeaf(root: TileNode, leafId: string): TileNode | null {
  const rec = (node: TileNode): TileNode | null => {
    if (node.type === 'leaf') return node.id === leafId ? null : node;
    const children: TileNode[] = [];
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

export function setLeafContent(root: TileNode, leafId: string, content: TileContent): TileNode {
  const rec = (node: TileNode): TileNode => {
    if (node.type === 'leaf') return node.id === leafId ? { ...node, content } : node;
    return { ...node, children: node.children.map(rec) };
  };
  return rec(root);
}

export function setSizes(root: TileNode, splitId: string, sizes: number[]): TileNode {
  const rec = (node: TileNode): TileNode => {
    if (node.type === 'leaf') return node;
    if (node.id === splitId && sizes.length === node.children.length) {
      return { ...node, sizes: [...sizes] };
    }
    return { ...node, children: node.children.map(rec) };
  };
  return rec(root);
}

/** Collapse single-child splits and merge same-direction nesting. */
export function normalize(node: TileNode | null): TileNode | null {
  if (!node || node.type === 'leaf') return node;
  const children: TileNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((c, i) => {
    const n = normalize(c);
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

/**
 * Place sessions that no leaf references yet: fill the first empty leaf,
 * else split the last terminal leaf side by side, else stack a new tile
 * under the whole layout. Returns the same object when nothing changed.
 */
export function adoptSessions(layout: WorktreeLayout, sessionIds: string[]): WorktreeLayout {
  const placed = new Set(
    leaves(layout.root)
      .map((l) => l.content)
      .filter((c): c is Extract<TileContent, { kind: 'terminal' }> => c.kind === 'terminal')
      .map((c) => c.sessionId),
  );
  const unplaced = sessionIds.filter((id) => !placed.has(id));
  if (unplaced.length === 0) return layout;

  let root = layout.root;
  for (const sessionId of unplaced) {
    const content: TileContent = { kind: 'terminal', sessionId };
    if (!root) {
      root = makeLeaf(content);
      continue;
    }
    const all = leaves(root);
    const empty = all.find((l) => l.content.kind === 'empty');
    if (empty) {
      root = setLeafContent(root, empty.id, content);
      continue;
    }
    const terminals = all.filter((l) => l.content.kind === 'terminal');
    if (terminals.length > 0) {
      root = splitLeaf(root, terminals[terminals.length - 1].id, 'row', content).root;
    } else {
      root = normalize({
        type: 'split',
        id: newId(),
        dir: 'column',
        sizes: [62, 38],
        children: [root, makeLeaf(content)],
      });
    }
  }
  return { ...layout, root };
}

/** Defensive validation for layouts loaded from localStorage. */
export function sanitize(value: unknown): WorktreeLayout | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as { version?: unknown; root?: unknown };
  if (v.version !== 1) return null;
  if (v.root === null) return { version: 1, root: null };

  const seenIds = new Set<string>();
  const seenSessions = new Set<string>();
  let seenFiles = false;
  let seenGit = false;

  const sanitizeContent = (c: unknown): TileContent => {
    if (typeof c !== 'object' || c === null) return { kind: 'empty' };
    const k = (c as { kind?: unknown }).kind;
    if (k === 'files') {
      if (seenFiles) return { kind: 'empty' };
      seenFiles = true;
      return { kind: 'files' };
    }
    if (k === 'git') {
      if (seenGit) return { kind: 'empty' };
      seenGit = true;
      return { kind: 'git' };
    }
    if (k === 'terminal') {
      const sessionId = (c as { sessionId?: unknown }).sessionId;
      if (typeof sessionId !== 'string' || sessionId === '' || seenSessions.has(sessionId)) {
        return { kind: 'empty' };
      }
      seenSessions.add(sessionId);
      return { kind: 'terminal', sessionId };
    }
    return { kind: 'empty' };
  };

  const uniqueId = (raw: unknown): string => {
    let id = typeof raw === 'string' && raw !== '' ? raw : newId();
    while (seenIds.has(id)) id = newId();
    seenIds.add(id);
    return id;
  };

  const sanitizeNode = (n: unknown): TileNode | null => {
    if (typeof n !== 'object' || n === null) return null;
    const node = n as {
      type?: unknown;
      id?: unknown;
      content?: unknown;
      dir?: unknown;
      sizes?: unknown;
      children?: unknown;
    };
    if (node.type === 'leaf') {
      return { type: 'leaf', id: uniqueId(node.id), content: sanitizeContent(node.content) };
    }
    if (node.type === 'split') {
      if (!Array.isArray(node.children)) return null;
      const children = node.children
        .map(sanitizeNode)
        .filter((c): c is TileNode => c !== null);
      if (children.length === 0) return null;
      const dir = node.dir === 'row' ? 'row' : 'column';
      const rawSizes = Array.isArray(node.sizes) ? node.sizes : [];
      const sizes =
        rawSizes.length === children.length && rawSizes.every((s) => typeof s === 'number' && s >= 0)
          ? renormalized(rawSizes as number[])
          : equalSizes(children.length);
      return { type: 'split', id: uniqueId(node.id), dir, sizes, children };
    }
    return null;
  };

  const root = sanitizeNode(v.root);
  if (!root) return null;
  return { version: 1, root: normalize(root) };
}
