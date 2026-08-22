// Tile layout tree: pure data + pure operations, no React.
// A layout is a tree of splits (row = side by side, column = stacked).
// v2: every leaf is a tabbed workspace — the view (files / git / term / chat)
// is switched INSIDE the tile, and terminal sessions belong to a leaf as tabs.
//
// The payload-independent structure ops (insert-beside / remove-with-collapse /
// normalize / sizes) live in splitTree.ts, shared with the editor-group tree
// inside a files panel. Everything session/view specific stays here.

import {
  equalSizes,
  findLeafOf,
  insertBesideLeaf,
  leavesOf,
  newId,
  normalizeOf,
  removeLeafOf,
  renormalized,
  setSizesOf,
  updateLeafOf,
} from './splitTree';

export { newId } from './splitTree';

export type TileView = 'files' | 'git' | 'term' | 'chat';

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
  return leavesOf<LeafNode>(node);
}

export function findLeaf(node: TileNode | null, leafId: string): LeafNode | null {
  return findLeafOf<LeafNode>(node, leafId);
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
  return { root: insertBesideLeaf<LeafNode>(root, leafId, dir, false, newLeaf), newLeafId: newLeaf.id };
}

/** Remove a leaf; collapses now-single-child splits. Returns null when empty. */
export function removeLeaf(root: TileNode, leafId: string): TileNode | null {
  return removeLeafOf<LeafNode>(root, leafId);
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
  const without = removeLeafOf<LeafNode>(root, srcId);
  if (!without) return root; // src was the only leaf — nothing to attach to
  return insertBesideLeaf<LeafNode>(without, targetId, dir, before, src);
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
  return updateLeafOf<LeafNode>(root, leafId, patch);
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
  return setSizesOf<LeafNode>(root, splitId, sizes);
}

/** Collapse single-child splits and merge same-direction nesting. */
export function normalize(node: TileNode | null): TileNode | null {
  return normalizeOf<LeafNode>(node);
}

/**
 * Attach sessions that no leaf owns yet as tabs of `preferLeafId` (else the
 * first term-view leaf, else the first leaf). Does NOT switch the target
 * leaf's view — adoption is a background event. Returns the same object when
 * nothing changed.
 *
 * kind ルーティング: chat (SDK) セッションは chat ビューの leaf にだけ
 * 養子縁組する (term タイルに xterm として現れないように)。受け皿の chat
 * leaf が無ければ据え置く — 作成元タブが place コールバックで明示的に引き取る。
 */
export function adoptSessions(
  layout: WorktreeLayout,
  sessions: { id: string; kind?: string }[],
  preferLeafId: string | null,
): WorktreeLayout {
  const all = leaves(layout.root);
  const owned = new Set(all.flatMap((l) => l.sessions));
  const unplaced = sessions.filter((s) => !owned.has(s.id));
  if (unplaced.length === 0) return layout;

  let root = layout.root ?? makeLeaf('term');
  let changed = false;
  for (const session of unplaced) {
    const current = leaves(root);
    const prefer = current.find((l) => l.id === preferLeafId);
    const target =
      session.kind === 'sdk'
        ? ((prefer?.view === 'chat' ? prefer : undefined) ??
          current.find((l) => l.view === 'chat'))
        : (prefer ?? current.find((l) => l.view === 'term') ?? current[0]);
    if (!target) continue;
    changed = true;
    root = updateLeaf(root, target.id, (leaf) => ({
      ...leaf,
      sessions: [...leaf.sessions, session.id],
      activeSession: leaf.activeSession ?? session.id,
    }));
  }
  if (!changed) return layout;
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
        node.view === 'files' || node.view === 'git' || node.view === 'term' || node.view === 'chat'
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
