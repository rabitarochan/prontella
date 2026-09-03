// Terminal-group layout inside ONE terminal panel (tile leaf): a split tree
// whose leaves are session tab groups, mirroring the editor-group tree in
// components/files/editorGroups.ts. Pure data + pure operations — no React,
// no xterm — so this module is vitest-covered (components .tsx are not; see
// pj-client-ui-state §0).
//
// OWNERSHIP INVARIANT: the tile tree (layout/tileTree.ts) stays the single
// source of truth for "which tile owns which session" (leaf.sessions /
// leaf.activeSession). This tree only PARTITIONS that id set into groups and
// follows it one-way through syncSessions(). Nothing here creates, kills or
// re-homes a session across tiles.
//
// Difference from editorGroups.ts that is easy to get wrong: a file tab may be
// open in two groups at once (they share one Monaco model), but one xterm
// session lives in EXACTLY ONE group — its DOM node can only have one parent.
// So splitWithSession always MOVES; there is no copy variant, and none of the
// reference-counting helpers (groupsWithKey / orphanedKeysAfter) exist here.

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
  type NodeOf,
  type SplitDir,
  type SplitOf,
} from './splitTree';

export interface TermGroup {
  type: 'leaf';
  id: string;
  /** owned terminal session ids, in tab order */
  sessions: string[];
  /** the group's active tab, always one of `sessions` (null when empty) */
  activeId: string | null;
}

export type TermGroupSplit = SplitOf<TermGroup>;
export type TermGroupNode = NodeOf<TermGroup>;

export function makeTermGroup(sessions: string[] = [], activeId: string | null = null): TermGroup {
  return { type: 'leaf', id: newId(), sessions, activeId };
}

/** All groups in stable tree order. */
export function allTermGroups(root: TermGroupNode | null): TermGroup[] {
  return leavesOf<TermGroup>(root);
}

export function findTermGroup(root: TermGroupNode | null, groupId: string): TermGroup | null {
  return findLeafOf<TermGroup>(root, groupId);
}

/** The group holding `sessionId`, or null. At most one group can hold it. */
export function groupOfSession(root: TermGroupNode, sessionId: string): TermGroup | null {
  return allTermGroups(root).find((g) => g.sessions.includes(sessionId)) ?? null;
}

/** Make `sessionId` the group's active tab (no-op when the group lacks it). */
export function activateSession(
  root: TermGroupNode,
  groupId: string,
  sessionId: string,
): TermGroupNode {
  return updateLeafOf<TermGroup>(root, groupId, (g) =>
    g.activeId !== sessionId && g.sessions.includes(sessionId) ? { ...g, activeId: sessionId } : g,
  );
}

/**
 * Insert `sessionId` into a group at `index` (else the end) and activate it.
 * A group already holding it just activates it (never duplicates).
 */
export function insertSessionInGroup(
  root: TermGroupNode,
  groupId: string,
  sessionId: string,
  index?: number,
): TermGroupNode {
  return updateLeafOf<TermGroup>(root, groupId, (g) => {
    if (g.sessions.includes(sessionId)) {
      return g.activeId === sessionId ? g : { ...g, activeId: sessionId };
    }
    const sessions = [...g.sessions];
    const at = Math.max(0, Math.min(index ?? sessions.length, sessions.length));
    sessions.splice(at, 0, sessionId);
    return { ...g, sessions, activeId: sessionId };
  });
}

// Remove one session from one group, fixing activeId (right neighbor, else
// left — the same rule as tileTree.removeSession / editorGroups). Does NOT
// prune a group left empty; callers decide (pruneEmptyTermGroups).
function withSessionRemoved(
  root: TermGroupNode,
  groupId: string,
  sessionId: string,
): TermGroupNode {
  return updateLeafOf<TermGroup>(root, groupId, (g) => {
    const idx = g.sessions.indexOf(sessionId);
    if (idx === -1) return g;
    const sessions = g.sessions.filter((s) => s !== sessionId);
    const activeId =
      g.activeId === sessionId ? (sessions[idx] ?? sessions[idx - 1] ?? null) : g.activeId;
    return { ...g, sessions, activeId };
  });
}

/**
 * Drop empty groups, keeping at least one group overall (when every group is
 * empty, the first survives as the placeholder). Never returns null.
 */
export function pruneEmptyTermGroups(root: TermGroupNode): TermGroupNode {
  const groups = allTermGroups(root);
  const empty = groups.filter((g) => g.sessions.length === 0);
  const removable = empty.length === groups.length ? empty.slice(1) : empty;
  if (removable.length === 0) return root;
  let out: TermGroupNode | null = root;
  for (const g of removable) {
    if (!out) break;
    out = removeLeafOf<TermGroup>(out, g.id);
  }
  return normalizeOf<TermGroup>(out) ?? makeTermGroup();
}

/**
 * Close one session tab in one group; a group left empty collapses away
 * (unless it is the panel's last group, which stays as the placeholder).
 */
export function closeSessionInGroup(
  root: TermGroupNode,
  groupId: string,
  sessionId: string,
): TermGroupNode {
  return pruneEmptyTermGroups(withSessionRemoved(root, groupId, sessionId));
}

/**
 * Reorder within a group. `toIndex` is the insertion index in the strip with
 * the dragged tab removed (clamped).
 */
export function reorderSession(
  root: TermGroupNode,
  groupId: string,
  sessionId: string,
  toIndex: number,
): TermGroupNode {
  return updateLeafOf<TermGroup>(root, groupId, (g) => {
    const from = g.sessions.indexOf(sessionId);
    if (from === -1) return g;
    const sessions = [...g.sessions];
    sessions.splice(from, 1);
    const at = Math.max(0, Math.min(toIndex, sessions.length));
    sessions.splice(at, 0, sessionId);
    return { ...g, sessions };
  });
}

/**
 * Move a session from `srcGroupId` into `dstGroupId` (at `index`, else the
 * end) and activate it there. A src group left empty collapses away.
 * src === dst degrades to reorderSession.
 */
export function moveSessionToGroup(
  root: TermGroupNode,
  srcGroupId: string,
  sessionId: string,
  dstGroupId: string,
  index?: number,
): TermGroupNode {
  const src = findTermGroup(root, srcGroupId);
  const dst = findTermGroup(root, dstGroupId);
  if (!src || !dst || !src.sessions.includes(sessionId)) return root;
  if (srcGroupId === dstGroupId) {
    return index === undefined ? root : reorderSession(root, srcGroupId, sessionId, index);
  }
  const out = insertSessionInGroup(
    withSessionRemoved(root, srcGroupId, sessionId),
    dstGroupId,
    sessionId,
    index,
  );
  return pruneEmptyTermGroups(out);
}

/**
 * Create a new group holding `sessionId` beside `dstGroupId` (edge drop / the
 * split button). Always a MOVE — the session leaves `sourceGroupId`, which
 * collapses if left empty (a terminal cannot live in two groups).
 *
 * Returns the root unchanged (newGroupId: null) when the move would be a
 * no-op: dst missing, the source does not hold the session, or splitting a
 * group off itself while it holds only that one session (the source would
 * collapse right back, churning ids for no layout change).
 */
export function splitWithSession(
  root: TermGroupNode,
  dstGroupId: string,
  dir: SplitDir,
  before: boolean,
  sessionId: string,
  sourceGroupId: string,
): { root: TermGroupNode; newGroupId: string | null } {
  const src = findTermGroup(root, sourceGroupId);
  if (!findTermGroup(root, dstGroupId) || !src || !src.sessions.includes(sessionId)) {
    return { root, newGroupId: null };
  }
  if (sourceGroupId === dstGroupId && src.sessions.length === 1) {
    return { root, newGroupId: null };
  }
  const group = makeTermGroup([sessionId], sessionId);
  const out = insertBesideLeaf<TermGroup>(
    withSessionRemoved(root, sourceGroupId, sessionId),
    dstGroupId,
    dir,
    before,
    group,
  );
  return { root: pruneEmptyTermGroups(out), newGroupId: group.id };
}

export function setTermGroupSizes(
  root: TermGroupNode,
  splitId: string,
  sizes: number[],
): TermGroupNode {
  return setSizesOf<TermGroup>(root, splitId, sizes);
}

/**
 * One-way follow of the tile leaf's session list (tileTree's leaf.sessions) —
 * the one-level-down twin of tileTree.adoptSessions:
 * - ids no group holds yet are appended to `preferGroupId` (else the first
 *   group) and become that group's active tab, in `ownedIds` order
 * - ids no longer owned are dropped from every group, and groups left empty
 *   collapse (the last group survives as the placeholder)
 *
 * Returns the SAME reference when nothing changed, so callers can run it from
 * a render-driven effect without looping.
 */
export function syncSessions(
  root: TermGroupNode,
  ownedIds: string[],
  preferGroupId: string | null,
  /** id ごとの受け皿グループ (存在すればこちらが preferGroupId より優先。null = 既定へ)。
   *  ターミナルモニターが「同じ worktree のセッションが居るグループへ」を実現するのに使う。 */
  preferFor?: (sessionId: string, root: TermGroupNode) => string | null,
): TermGroupNode {
  const owned = new Set(ownedIds);
  const groups = allTermGroups(root);
  const placed = new Set(groups.flatMap((g) => g.sessions));
  const stale = groups.flatMap((g) =>
    g.sessions.filter((s) => !owned.has(s)).map((s) => ({ groupId: g.id, sessionId: s })),
  );
  const missing = ownedIds.filter((id) => !placed.has(id));
  if (stale.length === 0 && missing.length === 0) return root;

  let out = root;
  for (const { groupId, sessionId } of stale) out = withSessionRemoved(out, groupId, sessionId);
  if (missing.length > 0) {
    const target = (preferGroupId && findTermGroup(out, preferGroupId)) || allTermGroups(out)[0];
    if (!target) {
      out = makeTermGroup(missing, missing[missing.length - 1]);
    } else {
      for (const id of missing) {
        const own = preferFor?.(id, out) ?? null;
        const dst = (own && findTermGroup(out, own)) || target;
        out = insertSessionInGroup(out, dst.id, id);
      }
    }
  }
  return pruneEmptyTermGroups(out);
}

/**
 * Defensive validation for a tree loaded from localStorage. Same policy as
 * tileTree.sanitize: regenerate missing/duplicate ids, drop duplicate session
 * ids (the "exactly one group" invariant), renormalize sizes.
 */
export function sanitizeTermGroups(value: unknown): TermGroupNode | null {
  const seenIds = new Set<string>();
  const seenSessions = new Set<string>();

  const uniqueId = (raw: unknown): string => {
    let id = typeof raw === 'string' && raw !== '' ? raw : newId();
    while (seenIds.has(id)) id = newId();
    seenIds.add(id);
    return id;
  };

  const rec = (n: unknown): TermGroupNode | null => {
    if (typeof n !== 'object' || n === null) return null;
    const node = n as {
      type?: unknown;
      id?: unknown;
      sessions?: unknown;
      activeId?: unknown;
      dir?: unknown;
      sizes?: unknown;
      children?: unknown;
    };
    if (node.type === 'leaf') {
      const sessions = (Array.isArray(node.sessions) ? node.sessions : []).filter(
        (s): s is string => {
          if (typeof s !== 'string' || s === '' || seenSessions.has(s)) return false;
          seenSessions.add(s);
          return true;
        },
      );
      const activeId =
        typeof node.activeId === 'string' && sessions.includes(node.activeId)
          ? node.activeId
          : (sessions[sessions.length - 1] ?? null);
      return { type: 'leaf', id: uniqueId(node.id), sessions, activeId };
    }
    if (node.type === 'split') {
      if (!Array.isArray(node.children)) return null;
      const children = node.children.map(rec).filter((c): c is TermGroupNode => c !== null);
      if (children.length === 0) return null;
      const dir: SplitDir = node.dir === 'row' ? 'row' : 'column';
      const rawSizes = Array.isArray(node.sizes) ? node.sizes : [];
      const sizes =
        rawSizes.length === children.length &&
        rawSizes.every((s) => typeof s === 'number' && s >= 0)
          ? renormalized(rawSizes as number[])
          : equalSizes(children.length);
      return { type: 'split', id: uniqueId(node.id), dir, sizes, children };
    }
    return null;
  };

  const root = rec(value);
  if (!root) return null;
  return normalizeOf<TermGroup>(root);
}
