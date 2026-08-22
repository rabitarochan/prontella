// Editor-group layout inside ONE files panel (tile leaf): a split tree whose
// leaves are tab groups, VS Code editor-group style. Pure data + pure
// operations — no React, no Monaco — so this module is vitest-covered
// (components .tsx are not; see pj-client-ui-state §0).
//
// The tree holds TAB REFERENCES only. File runtime state (content / draft /
// dirty / error) lives in the panel's flat per-key pool: a tab open in two
// groups shares one pool entry (and one Monaco model), which is what makes
// "draft/dirty is per file" hold by construction. Reference counting is
// DERIVED from the tree (groupsWithKey / orphanedKeysAfter) — there is no
// separate counter state to drift out of sync.

import { refKey, tabKey, type OpenTabRef, type TabKind } from '../../editorState';
import {
  findLeafOf,
  insertBesideLeaf,
  leavesOf,
  newId,
  normalizeOf,
  removeLeafOf,
  setSizesOf,
  updateLeafOf,
  type NodeOf,
  type SplitDir,
  type SplitOf,
} from '../../layout/splitTree';

export interface EditorGroup {
  type: 'leaf';
  id: string;
  /** open tabs in strip order */
  tabs: OpenTabRef[];
  /** tabKey(kind, path) of the group's active tab */
  activeKey: string | null;
}

export type GroupSplit = SplitOf<EditorGroup>;
export type GroupNode = NodeOf<EditorGroup>;

export function makeGroup(tabs: OpenTabRef[] = [], activeKey: string | null = null): EditorGroup {
  return { type: 'leaf', id: newId(), tabs, activeKey };
}

/** All groups in stable tree order. */
export function allGroups(root: GroupNode | null): EditorGroup[] {
  return leavesOf<EditorGroup>(root);
}

export function findGroup(root: GroupNode | null, groupId: string): EditorGroup | null {
  return findLeafOf<EditorGroup>(root, groupId);
}

/** Ids of the groups holding `key`, in tree order. length == the key's ref count. */
export function groupsWithKey(root: GroupNode, key: string): string[] {
  return allGroups(root)
    .filter((g) => g.tabs.some((t) => refKey(t) === key))
    .map((g) => g.id);
}

/** Every distinct tab key in the tree, ordered by first appearance. This is the
 *  panel's resource pool key set (models / file entries / drafts follow it). */
export function distinctKeys(root: GroupNode): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const g of allGroups(root)) {
    for (const t of g.tabs) {
      const k = refKey(t);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(k);
      }
    }
  }
  return out;
}

/** Every distinct tab ref in the tree, ordered by first appearance — the
 *  refs the panel's file-entry pool must hold. */
export function distinctRefs(root: GroupNode): OpenTabRef[] {
  const seen = new Set<string>();
  const out: OpenTabRef[] = [];
  for (const g of allGroups(root)) {
    for (const t of g.tabs) {
      const k = refKey(t);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(t);
      }
    }
  }
  return out;
}

/** Keys referenced in `before` that no group references in `after` — exactly
 *  the resources (model, file entry, draft, per-path refs) safe to dispose. */
export function orphanedKeysAfter(before: GroupNode, after: GroupNode): string[] {
  const alive = new Set(distinctKeys(after));
  return distinctKeys(before).filter((k) => !alive.has(k));
}

/** Make `key` the group's active tab (no-op when the group doesn't hold it). */
export function activateTab(root: GroupNode, groupId: string, key: string): GroupNode {
  return updateLeafOf<EditorGroup>(root, groupId, (g) =>
    g.activeKey !== key && g.tabs.some((t) => refKey(t) === key) ? { ...g, activeKey: key } : g,
  );
}

/** Add `ref` to the group (at the end) and activate it; already open in the
 *  group → just activate. Other groups holding the same key are untouched —
 *  like VS Code, opening a file targets the active group regardless. */
export function openTabInGroup(root: GroupNode, groupId: string, ref: OpenTabRef): GroupNode {
  const key = refKey(ref);
  return updateLeafOf<EditorGroup>(root, groupId, (g) => {
    if (g.tabs.some((t) => refKey(t) === key)) {
      return g.activeKey === key ? g : { ...g, activeKey: key };
    }
    return { ...g, tabs: [...g.tabs, ref], activeKey: key };
  });
}

// Remove one tab from one group, fixing the group's activeKey (right neighbor,
// else left — same rule as tileTree.removeSession). Does NOT prune the group
// when it becomes empty; callers decide (pruneEmptyGroups).
function withTabRemoved(root: GroupNode, groupId: string, key: string): GroupNode {
  return updateLeafOf<EditorGroup>(root, groupId, (g) => {
    const idx = g.tabs.findIndex((t) => refKey(t) === key);
    if (idx === -1) return g;
    const tabs = g.tabs.filter((t) => refKey(t) !== key);
    const activeKey =
      g.activeKey === key
        ? (tabs[idx] ? refKey(tabs[idx]) : tabs[idx - 1] ? refKey(tabs[idx - 1]) : null)
        : g.activeKey;
    return { ...g, tabs, activeKey };
  });
}

/**
 * Drop empty groups, keeping at least one group overall (when every group is
 * empty, the first survives as the placeholder). Never returns null.
 */
export function pruneEmptyGroups(root: GroupNode): GroupNode {
  const groups = allGroups(root);
  const empty = groups.filter((g) => g.tabs.length === 0);
  const removable = empty.length === groups.length ? empty.slice(1) : empty;
  let out: GroupNode | null = root;
  for (const g of removable) {
    if (!out) break;
    out = removeLeafOf<EditorGroup>(out, g.id);
  }
  return normalizeOf<EditorGroup>(out) ?? makeGroup();
}

/** Close one tab in one group; a group left empty collapses away (unless it is
 *  the panel's last group, which stays as the placeholder). */
export function closeTabInGroup(root: GroupNode, groupId: string, key: string): GroupNode {
  return pruneEmptyGroups(withTabRemoved(root, groupId, key));
}

/** `path` が `base` 自身、または `base + '/'` 配下(= ディレクトリー操作の巻き込み対象)か。 */
export function pathIsWithin(path: string, base: string): boolean {
  return path === base || path.startsWith(base + '/');
}

/**
 * ファイル/ディレクトリーのリネームで `path` がどう変わるかを返す: `from` と完全一致、
 * または `from + '/'` 配下(ディレクトリーリネーム)なら新パス、無関係なら null。
 */
export function renamedPath(path: string, from: string, to: string): string | null {
  if (path === from) return to;
  if (path.startsWith(from + '/')) return to + path.slice(from.length);
  return null;
}

/**
 * 削除 (`target` とその配下) に該当するタブ参照を全グループから取り除く。
 * activeKey が消えたグループは closeTabInGroup と同じ「右隣、なければ左隣」ルールで
 * 生き残りタブへ引き継ぎ、空になったグループは畳む (最後の 1 グループは残る)。
 */
export function removeTabPaths(root: GroupNode, target: string): GroupNode {
  let out = root;
  for (const g of allGroups(root)) {
    out = updateLeafOf<EditorGroup>(out, g.id, (leaf) => {
      const keep = leaf.tabs.filter((t) => !pathIsWithin(t.path, target));
      if (keep.length === leaf.tabs.length) return leaf;
      let activeKey = leaf.activeKey;
      if (activeKey !== null && !keep.some((t) => refKey(t) === activeKey)) {
        const idx = leaf.tabs.findIndex((t) => refKey(t) === activeKey);
        const kept = new Set(keep.map((t) => refKey(t)));
        let next: string | null = null;
        for (let i = idx + 1; i < leaf.tabs.length && next === null; i++) {
          if (kept.has(refKey(leaf.tabs[i]))) next = refKey(leaf.tabs[i]);
        }
        for (let i = idx - 1; i >= 0 && next === null; i--) {
          if (kept.has(refKey(leaf.tabs[i]))) next = refKey(leaf.tabs[i]);
        }
        activeKey = next;
      }
      return { ...leaf, tabs: keep, activeKey };
    });
  }
  return pruneEmptyGroups(out);
}

/**
 * リネーム (`from` → `to`) を全グループのタブ参照と activeKey に反映する。
 * 書き換え後に同一グループ内でキーが重複した場合は先勝ちで dedupe する
 * (「グループ内で同一キーは重複しない」不変条件の維持。新パスのタブが既に同じ
 * グループにあるのはロードエラー中のタブ等の稀なケースのみ)。
 */
export function renameTabPaths(root: GroupNode, from: string, to: string): GroupNode {
  let out = root;
  for (const g of allGroups(root)) {
    out = updateLeafOf<EditorGroup>(out, g.id, (leaf) => {
      let changed = false;
      const seen = new Set<string>();
      const tabs: OpenTabRef[] = [];
      for (const t of leaf.tabs) {
        const np = renamedPath(t.path, from, to);
        const nt = np === null ? t : { ...t, path: np };
        if (nt !== t) changed = true;
        const k = refKey(nt);
        if (seen.has(k)) {
          changed = true;
          continue;
        }
        seen.add(k);
        tabs.push(nt);
      }
      if (!changed) return leaf;
      let activeKey = leaf.activeKey;
      if (activeKey !== null) {
        const sep = activeKey.indexOf(':');
        const kind = activeKey.slice(0, sep) as TabKind;
        const np = renamedPath(activeKey.slice(sep + 1), from, to);
        if (np !== null) activeKey = tabKey(kind, np);
      }
      return { ...leaf, tabs, activeKey };
    });
  }
  return out;
}

/** Reorder within a group. `toIndex` is the insertion index in the strip with
 *  the dragged tab removed (clamped). */
export function reorderTab(root: GroupNode, groupId: string, key: string, toIndex: number): GroupNode {
  return updateLeafOf<EditorGroup>(root, groupId, (g) => {
    const from = g.tabs.findIndex((t) => refKey(t) === key);
    if (from === -1) return g;
    const tabs = [...g.tabs];
    const [ref] = tabs.splice(from, 1);
    const at = Math.max(0, Math.min(toIndex, tabs.length));
    tabs.splice(at, 0, ref);
    return { ...g, tabs };
  });
}

/** Insert `ref` into a group at `index` (else the end) and activate it; a group
 *  already holding the key just activates it (never duplicates within a group). */
export function insertTabInGroup(
  root: GroupNode,
  groupId: string,
  ref: OpenTabRef,
  index?: number,
): GroupNode {
  const key = refKey(ref);
  return updateLeafOf<EditorGroup>(root, groupId, (g) => {
    if (g.tabs.some((t) => refKey(t) === key)) return { ...g, activeKey: key };
    const tabs = [...g.tabs];
    const at = Math.max(0, Math.min(index ?? tabs.length, tabs.length));
    tabs.splice(at, 0, ref);
    return { ...g, tabs, activeKey: key };
  });
}

/**
 * Move a tab from `srcGroupId` into `dstGroupId` (at `index`, else the end)
 * and activate it there. If dst already holds the same key, the drop just
 * activates the existing tab (never duplicates within a group). A src group
 * left empty collapses away. src === dst degrades to reorderTab.
 */
export function moveTabToGroup(
  root: GroupNode,
  srcGroupId: string,
  key: string,
  dstGroupId: string,
  index?: number,
): GroupNode {
  const src = findGroup(root, srcGroupId);
  const dst = findGroup(root, dstGroupId);
  if (!src || !dst) return root;
  const ref = src.tabs.find((t) => refKey(t) === key);
  if (!ref) return root;
  if (srcGroupId === dstGroupId) {
    return index === undefined ? root : reorderTab(root, srcGroupId, key, index);
  }
  const out = insertTabInGroup(withTabRemoved(root, srcGroupId, key), dstGroupId, ref, index);
  return pruneEmptyGroups(out);
}

/**
 * Create a new group holding `ref` beside `dstGroupId` (edge drop / the split
 * button). With `source` given the tab MOVES (removed from the source group,
 * which collapses if left empty); without it the tab is COPIED (split button —
 * the same key then lives in both groups, sharing one model/draft).
 * Returns the root unchanged (newGroupId: null) when dst is missing.
 */
export function splitWithTab(
  root: GroupNode,
  dstGroupId: string,
  dir: SplitDir,
  before: boolean,
  ref: OpenTabRef,
  source?: { groupId: string },
): { root: GroupNode; newGroupId: string | null } {
  if (!findGroup(root, dstGroupId)) return { root, newGroupId: null };
  let out: GroupNode = root;
  if (source) out = withTabRemoved(out, source.groupId, refKey(ref));
  const group = makeGroup([ref], refKey(ref));
  out = insertBesideLeaf<EditorGroup>(out, dstGroupId, dir, before, group);
  return { root: pruneEmptyGroups(out), newGroupId: group.id };
}

/**
 * Pick the tab to auto-close when the panel would exceed its open-files cap.
 * Mirrors the old flat-tab eviction rules via `isEvictable` (caller supplies
 * "loaded and not dirty") plus two structural rules of its own: never a key in
 * `excludeKeys` (the tab being opened / the previously active tab), and never
 * a key open in more than one group (closing one ref would free no resources).
 */
export function pickEviction(
  root: GroupNode,
  opts: { excludeKeys: Iterable<string>; isEvictable: (key: string) => boolean },
): { groupId: string; key: string } | null {
  const exclude = new Set(opts.excludeKeys);
  for (const g of allGroups(root)) {
    for (const t of g.tabs) {
      const key = refKey(t);
      if (exclude.has(key)) continue;
      if (groupsWithKey(root, key).length !== 1) continue;
      if (!opts.isEvictable(key)) continue;
      return { groupId: g.id, key };
    }
  }
  return null;
}

export function setGroupSizes(root: GroupNode, splitId: string, sizes: number[]): GroupNode {
  return setSizesOf<EditorGroup>(root, splitId, sizes);
}

export { tabKey };
