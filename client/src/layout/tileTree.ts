// Tile layout tree: pure data + pure operations, no React.
// A layout is a tree of splits (row = side by side, column = stacked).
// v2: every leaf is a tabbed workspace — the view (files / git / term) is
// switched INSIDE the tile, and terminal sessions belong to a leaf as tabs.

export type TileView = 'files' | 'git' | 'term';

export interface LeafNode {
  type: 'leaf';
  id: string;
  view: TileView;
  /** owned terminal session ids, in tab order */
  sessions: string[];
  activeSession: string | null;
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
  version: 2;
  root: TileNode | null;
}

export function newId(): string {
  return crypto.randomUUID().slice(0, 8);
}

export function makeLeaf(view: TileView): LeafNode {
  return { type: 'leaf', id: newId(), view, sessions: [], activeSession: null };
}

/** Reproduces the classic look: files on top, terminal area below. */
export function createDefaultLayout(): WorktreeLayout {
  return {
    version: 2,
    root: {
      type: 'split',
      id: newId(),
      dir: 'column',
      sizes: [62, 38],
      children: [makeLeaf('files'), makeLeaf('term')],
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
 * Split `leafId` in direction `dir`, placing a new leaf after it. If the
 * leaf's parent already splits in `dir`, the new leaf is inserted as a
 * sibling (taking half of the target's share); otherwise the leaf is wrapped
 * into a new 50/50 split.
 */
export function splitLeaf(
  root: TileNode,
  leafId: string,
  dir: 'row' | 'column',
  view: TileView = 'term',
): { root: TileNode; newLeafId: string } {
  const newLeaf = makeLeaf(view);

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

/**
 * Move leaf `srcId` next to leaf `targetId`: remove it from its current
 * position (collapsing its old parent like removeLeaf), then insert it
 * beside the target with splitLeaf's rules — extending a same-dir split
 * in place, otherwise wrapping the target into a new 50/50 split.
 * No-ops (returns root unchanged) when src === target, either id is
 * missing, or src is the only leaf.
 */
export function moveLeaf(
  root: TileNode,
  srcId: string,
  targetId: string,
  dir: 'row' | 'column',
  before: boolean,
): TileNode {
  if (srcId === targetId) return root;
  const src = findLeaf(root, srcId);
  if (!src || !findLeaf(root, targetId)) return root;
  const without = removeLeaf(root, srcId);
  if (!without) return root; // src was the only leaf — nothing to attach to

  const insert = (node: TileNode): TileNode => {
    if (node.type === 'leaf') {
      if (node.id !== targetId) return node;
      const children = before ? [src, node] : [node, src];
      return { type: 'split', id: newId(), dir, sizes: [50, 50], children };
    }
    const idx = node.children.findIndex((c) => c.type === 'leaf' && c.id === targetId);
    if (idx >= 0 && node.dir === dir) {
      const children = [...node.children];
      const sizes = [...node.sizes];
      const half = (sizes[idx] ?? 100 / node.children.length) / 2;
      sizes[idx] = half;
      const at = before ? idx : idx + 1;
      children.splice(at, 0, src);
      sizes.splice(at, 0, half);
      return { ...node, children, sizes };
    }
    return { ...node, children: node.children.map(insert) };
  };
  return insert(without);
}

/**
 * Swap the tree positions of two leaves. Content follows leaf.id (the portal
 * layer is keyed by it), so a swap re-parents both hosts without remounts.
 */
export function swapLeaves(root: TileNode, aId: string, bId: string): TileNode {
  if (aId === bId) return root;
  const a = findLeaf(root, aId);
  const b = findLeaf(root, bId);
  if (!a || !b) return root;
  const rec = (node: TileNode): TileNode => {
    if (node.type === 'leaf') {
      if (node.id === aId) return b;
      if (node.id === bId) return a;
      return node;
    }
    return { ...node, children: node.children.map(rec) };
  };
  return rec(root);
}

export function updateLeaf(
  root: TileNode,
  leafId: string,
  patch: (leaf: LeafNode) => LeafNode,
): TileNode {
  const rec = (node: TileNode): TileNode => {
    if (node.type === 'leaf') return node.id === leafId ? patch(node) : node;
    return { ...node, children: node.children.map(rec) };
  };
  return rec(root);
}

/** Append a session as the leaf's last tab and make it active. */
export function appendSession(root: TileNode, leafId: string, sessionId: string): TileNode {
  return updateLeaf(root, leafId, (leaf) =>
    leaf.sessions.includes(sessionId)
      ? { ...leaf, activeSession: sessionId }
      : { ...leaf, sessions: [...leaf.sessions, sessionId], activeSession: sessionId },
  );
}

/** Remove a session tab; the neighbor (right, else left) becomes active. */
export function removeSession(root: TileNode, leafId: string, sessionId: string): TileNode {
  return updateLeaf(root, leafId, (leaf) => {
    const idx = leaf.sessions.indexOf(sessionId);
    if (idx === -1) return leaf;
    const sessions = leaf.sessions.filter((s) => s !== sessionId);
    const activeSession =
      leaf.activeSession === sessionId
        ? (sessions[idx] ?? sessions[idx - 1] ?? null)
        : leaf.activeSession;
    return { ...leaf, sessions, activeSession };
  });
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
 * Attach sessions that no leaf owns yet as tabs of `preferLeafId` (else the
 * first term-view leaf, else the first leaf). Does NOT switch the target
 * leaf's view — adoption is a background event. Returns the same object when
 * nothing changed.
 */
export function adoptSessions(
  layout: WorktreeLayout,
  sessionIds: string[],
  preferLeafId: string | null,
): WorktreeLayout {
  const all = leaves(layout.root);
  const owned = new Set(all.flatMap((l) => l.sessions));
  const unplaced = sessionIds.filter((id) => !owned.has(id));
  if (unplaced.length === 0) return layout;

  let root = layout.root;
  if (!root) root = makeLeaf('term');
  const current = leaves(root);
  const target =
    current.find((l) => l.id === preferLeafId) ??
    current.find((l) => l.view === 'term') ??
    current[0];

  for (const sessionId of unplaced) {
    root = updateLeaf(root, target.id, (leaf) => ({
      ...leaf,
      sessions: [...leaf.sessions, sessionId],
      activeSession: leaf.activeSession ?? sessionId,
    }));
  }
  return { ...layout, root };
}

/**
 * Drop owned session ids that are not alive (used once per page load —
 * sessions that died while the page was open keep their tab so the last
 * output stays visible).
 */
export function pruneSessions(layout: WorktreeLayout, liveIds: string[]): WorktreeLayout {
  const live = new Set(liveIds);
  let changed = false;
  const rec = (node: TileNode): TileNode => {
    if (node.type === 'leaf') {
      const sessions = node.sessions.filter((s) => live.has(s));
      if (sessions.length === node.sessions.length) return node;
      changed = true;
      const activeSession =
        node.activeSession && sessions.includes(node.activeSession)
          ? node.activeSession
          : (sessions[sessions.length - 1] ?? null);
      return { ...node, sessions, activeSession };
    }
    return { ...node, children: node.children.map(rec) };
  };
  const root = layout.root ? rec(layout.root) : null;
  return changed ? { ...layout, root } : layout;
}

/** Defensive validation for layouts loaded from localStorage. */
export function sanitize(value: unknown): WorktreeLayout | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as { version?: unknown; root?: unknown };
  if (v.version !== 2) return null;
  if (v.root === null) return { version: 2, root: null };

  const seenIds = new Set<string>();
  const seenSessions = new Set<string>();

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
      view?: unknown;
      sessions?: unknown;
      activeSession?: unknown;
      dir?: unknown;
      sizes?: unknown;
      children?: unknown;
    };
    if (node.type === 'leaf') {
      const view: TileView =
        node.view === 'files' || node.view === 'git' || node.view === 'term'
          ? node.view
          : 'term';
      const sessions = (Array.isArray(node.sessions) ? node.sessions : []).filter(
        (s): s is string => {
          if (typeof s !== 'string' || s === '' || seenSessions.has(s)) return false;
          seenSessions.add(s);
          return true;
        },
      );
      const activeSession =
        typeof node.activeSession === 'string' && sessions.includes(node.activeSession)
          ? node.activeSession
          : (sessions[sessions.length - 1] ?? null);
      return { type: 'leaf', id: uniqueId(node.id), view, sessions, activeSession };
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
  return { version: 2, root: normalize(root) };
}
