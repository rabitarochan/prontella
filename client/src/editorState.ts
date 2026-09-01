// Per-worktree editor UI state (editor-group tree, open tabs, active tab, Monaco
// view states, dirty drafts) persisted to localStorage, keyed by tile leaf id.
// Sibling of layout/useTileLayout.ts's WorktreeLayout persistence but a separate
// document, since which files are open is a property of a leaf's editor, not of
// the tile tree shape.
//
// v2 (editor groups): each leaf holds a split tree of tab groups (see
// components/files/editorGroups.ts — imported as types only, so there is no
// runtime cycle). v1 documents (flat openFiles/activeTab per leaf) migrate on
// read into a single group; writes are always v2.

import type { EditorGroup, GroupNode } from './components/files/editorGroups';
import { equalSizes, newId, normalizeOf, renormalized } from './layout/splitTree';

export type TabKind = 'editor' | 'preview';

/** Identifies one open tab. Tab identity is the `{kind, path}` pair, not `path` alone —
 *  an editor tab and a preview tab for the same path are distinct tabs. */
export interface OpenTabRef {
  kind: TabKind;
  path: string;
}

/** The derived identity string for a tab ref — used for React keys / lookups /
 *  group activeKey. Kept here (next to OpenTabRef) as the single definition. */
export function tabKey(kind: TabKind, path: string): string {
  return `${kind}:${path}`;
}

export function refKey(ref: OpenTabRef): string {
  return tabKey(ref.kind, ref.path);
}

export interface LeafEditorState {
  /** Editor-group split tree; leaves are tab groups (worktree-root-relative paths,
   *  in strip order). Always at least one group (possibly empty). */
  groups: GroupNode;
  /** Which group openFile / Ctrl+P etc. target. Always a valid group id. */
  activeGroupId: string;
  /** groupId -> path -> opaque Monaco viewState JSON. Editor tabs only — view
   *  state is PER GROUP (two groups showing one file scroll independently). */
  viewStates: Record<string, Record<string, unknown>>;
  /** path -> unsaved edit, for dirty tabs only. Editor tabs only, keyed by path
   *  ACROSS groups — groups share one model/draft per file (see editorGroups.ts). */
  drafts: Record<string, { text: string; baseHash: string }>;
}

export interface WorktreeEditorState {
  version: 2;
  /** key = tile leaf id */
  leaves: Record<string, LeafEditorState>;
}

// Caps the number of DISTINCT open tab keys per leaf on RESTORE (across all of
// the leaf's groups — a key open in two groups shares one model/file entry, so
// the second reference is free and does not count). Exported so FilesTab can
// enforce the same cap at runtime — restore-time and live-session caps must agree.
export const MAX_OPEN_FILES = 50;
// Matches server/files.ts's MAX_FILE_SIZE (2MB) so the invariant "any file the
// server will open has a draft size limit that can hold its full content"
// holds. If this were smaller than MAX_FILE_SIZE, an edited draft for a file
// near that size could be silently dropped on restore even though flush()
// happily wrote it (see useFileEntries' flush computation, which mirrors this
// same constant so writes and reads agree on the limit).
export const MAX_DRAFT_TEXT_LENGTH = 2_000_000;

function hasDotDotSegment(p: string): boolean {
  return p.split('/').includes('..');
}

/** Validates one open-tab entry. Accepts the legacy bare-string shape (always
 *  treated as an `'editor'` tab) as well as the current `{kind, path}` shape. */
function sanitizeTabRef(entry: unknown): OpenTabRef | null {
  if (typeof entry === 'string') {
    if (entry === '' || hasDotDotSegment(entry)) return null;
    return { kind: 'editor', path: entry };
  }
  if (typeof entry === 'object' && entry !== null) {
    const e = entry as { kind?: unknown; path?: unknown };
    if (
      (e.kind === 'editor' || e.kind === 'preview') &&
      typeof e.path === 'string' &&
      e.path !== '' &&
      !hasDotDotSegment(e.path)
    ) {
      return { kind: e.kind, path: e.path };
    }
  }
  return null;
}

function sanitizeDraft(raw: unknown): { text: string; baseHash: string } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const d = raw as { text?: unknown; baseHash?: unknown };
  if (typeof d.text !== 'string' || typeof d.baseHash !== 'string') return null;
  if (d.text.length > MAX_DRAFT_TEXT_LENGTH) return null;
  return { text: d.text, baseHash: d.baseHash };
}

function makeEmptyGroup(): EditorGroup {
  return { type: 'leaf', id: newId(), tabs: [], activeKey: null };
}

/** Editor-tab paths per group id, plus the union across groups. */
function editorPathIndex(root: GroupNode): {
  perGroup: Map<string, Set<string>>;
  all: Set<string>;
} {
  const perGroup = new Map<string, Set<string>>();
  const all = new Set<string>();
  const rec = (node: GroupNode): void => {
    if (node.type === 'leaf') {
      const paths = new Set<string>();
      for (const t of node.tabs) {
        if (t.kind === 'editor') {
          paths.add(t.path);
          all.add(t.path);
        }
      }
      perGroup.set(node.id, paths);
      return;
    }
    node.children.forEach(rec);
  };
  rec(root);
  return { perGroup, all };
}

function groupIds(root: GroupNode): string[] {
  if (root.type === 'leaf') return [root.id];
  return root.children.flatMap(groupIds);
}

// ---- v1 (flat) leaf shape, kept as the migration source ---------------------

interface LegacyLeafState {
  openFiles: OpenTabRef[];
  activeTab: OpenTabRef | null;
  viewStates: Record<string, unknown>;
  drafts: Record<string, { text: string; baseHash: string }>;
}

function tabRefsEqual(a: OpenTabRef, b: OpenTabRef): boolean {
  return a.kind === b.kind && a.path === b.path;
}

function sanitizeOpenFiles(raw: unknown): OpenTabRef[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: OpenTabRef[] = [];
  for (const entry of raw) {
    if (out.length >= MAX_OPEN_FILES) break;
    const ref = sanitizeTabRef(entry);
    if (!ref) continue;
    const key = refKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function sanitizeLegacyLeafState(l: {
  openFiles?: unknown;
  activeFile?: unknown;
  activeTab?: unknown;
  viewStates?: unknown;
  drafts?: unknown;
}): LegacyLeafState {
  const openFiles = sanitizeOpenFiles(l.openFiles);

  // activeTab: read the new field first; fall back to the legacy `activeFile: string`
  // (always an editor tab); fall back to the last open tab if neither is valid or open.
  let activeTab: OpenTabRef | null = null;
  const activeTabCandidate = sanitizeTabRef(l.activeTab);
  const legacyActiveFileCandidate =
    typeof l.activeFile === 'string' ? sanitizeTabRef(l.activeFile) : null;
  if (activeTabCandidate && openFiles.some((f) => tabRefsEqual(f, activeTabCandidate))) {
    activeTab = activeTabCandidate;
  } else if (
    legacyActiveFileCandidate &&
    openFiles.some((f) => tabRefsEqual(f, legacyActiveFileCandidate))
  ) {
    activeTab = legacyActiveFileCandidate;
  } else {
    activeTab = openFiles[openFiles.length - 1] ?? null;
  }

  // viewStates / drafts are keyed by path and only ever belong to editor tabs — a
  // path that is only open as a preview tab has no Monaco state or dirty draft to keep.
  const editorPaths = new Set(openFiles.filter((f) => f.kind === 'editor').map((f) => f.path));

  const viewStates: Record<string, unknown> = {};
  if (typeof l.viewStates === 'object' && l.viewStates !== null) {
    for (const [path, v] of Object.entries(l.viewStates as Record<string, unknown>)) {
      if (editorPaths.has(path) && typeof v === 'object' && v !== null) {
        viewStates[path] = v;
      }
    }
  }

  const drafts: Record<string, { text: string; baseHash: string }> = {};
  if (typeof l.drafts === 'object' && l.drafts !== null) {
    for (const [path, v] of Object.entries(l.drafts as Record<string, unknown>)) {
      if (!editorPaths.has(path)) continue;
      const draft = sanitizeDraft(v);
      if (draft) drafts[path] = draft;
    }
  }

  return { openFiles, activeTab, viewStates, drafts };
}

/** Wrap a validated flat (v1) leaf into a single editor group. Pure. */
export function migrateLegacyLeaf(legacy: LegacyLeafState): LeafEditorState {
  const group: EditorGroup = {
    type: 'leaf',
    id: newId(),
    tabs: legacy.openFiles,
    activeKey: legacy.activeTab ? refKey(legacy.activeTab) : null,
  };
  return {
    groups: group,
    activeGroupId: group.id,
    viewStates: Object.keys(legacy.viewStates).length > 0 ? { [group.id]: legacy.viewStates } : {},
    drafts: legacy.drafts,
  };
}

// ---- v2 (grouped) leaf sanitize --------------------------------------------

function sanitizeLeafState(raw: unknown): LeafEditorState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const l = raw as {
    groups?: unknown;
    activeGroupId?: unknown;
    openFiles?: unknown;
    activeFile?: unknown;
    activeTab?: unknown;
    viewStates?: unknown;
    drafts?: unknown;
  };
  if (l.groups === undefined) {
    // v1 shape (or older) — run it through the legacy validator, then wrap.
    return migrateLegacyLeaf(sanitizeLegacyLeafState(l));
  }

  const seenIds = new Set<string>();
  const uniqueId = (rawId: unknown): string => {
    let id = typeof rawId === 'string' && rawId !== '' ? rawId : newId();
    while (seenIds.has(id)) id = newId();
    seenIds.add(id);
    return id;
  };

  // Cap DISTINCT keys across the whole leaf; a key already admitted in some
  // group is free (it shares that key's model/file entry).
  const admittedKeys = new Set<string>();

  const sanitizeGroupNode = (n: unknown): GroupNode | null => {
    if (typeof n !== 'object' || n === null) return null;
    const node = n as {
      type?: unknown;
      id?: unknown;
      tabs?: unknown;
      activeKey?: unknown;
      dir?: unknown;
      sizes?: unknown;
      children?: unknown;
    };
    if (node.type === 'leaf') {
      const inGroup = new Set<string>();
      const tabs: OpenTabRef[] = [];
      for (const entry of Array.isArray(node.tabs) ? node.tabs : []) {
        const ref = sanitizeTabRef(entry);
        if (!ref) continue;
        const key = refKey(ref);
        if (inGroup.has(key)) continue; // never duplicated within one group
        if (!admittedKeys.has(key) && admittedKeys.size >= MAX_OPEN_FILES) continue;
        admittedKeys.add(key);
        inGroup.add(key);
        tabs.push(ref);
      }
      const activeKey =
        typeof node.activeKey === 'string' && tabs.some((t) => refKey(t) === node.activeKey)
          ? node.activeKey
          : tabs.length > 0
            ? refKey(tabs[tabs.length - 1])
            : null;
      return { type: 'leaf', id: uniqueId(node.id), tabs, activeKey };
    }
    if (node.type === 'split') {
      if (!Array.isArray(node.children)) return null;
      const children = node.children
        .map(sanitizeGroupNode)
        .filter((c): c is GroupNode => c !== null);
      if (children.length === 0) return null;
      if (children.length === 1) return children[0];
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

  // Empty groups are restore-time junk (a live panel prunes them on close/move);
  // drop them here, keeping one only when nothing else survives.
  const dropEmptyGroups = (node: GroupNode | null): GroupNode | null => {
    if (!node) return null;
    if (node.type === 'leaf') return node.tabs.length > 0 ? node : null;
    const children: GroupNode[] = [];
    const sizes: number[] = [];
    node.children.forEach((c, i) => {
      const r = dropEmptyGroups(c);
      if (r) {
        children.push(r);
        sizes.push(node.sizes[i] ?? 100 / node.children.length);
      }
    });
    if (children.length === 0) return null;
    if (children.length === 1) return children[0];
    return { ...node, children, sizes: renormalized(sizes) };
  };

  const groups =
    normalizeOf<EditorGroup>(dropEmptyGroups(sanitizeGroupNode(l.groups))) ?? makeEmptyGroup();

  const ids = groupIds(groups);
  const activeGroupId =
    typeof l.activeGroupId === 'string' && ids.includes(l.activeGroupId) ? l.activeGroupId : ids[0];

  const { perGroup, all } = editorPathIndex(groups);

  const viewStates: Record<string, Record<string, unknown>> = {};
  if (typeof l.viewStates === 'object' && l.viewStates !== null) {
    for (const [gid, rawStates] of Object.entries(l.viewStates as Record<string, unknown>)) {
      const groupPaths = perGroup.get(gid);
      if (!groupPaths || typeof rawStates !== 'object' || rawStates === null) continue;
      const states: Record<string, unknown> = {};
      for (const [path, v] of Object.entries(rawStates as Record<string, unknown>)) {
        if (groupPaths.has(path) && typeof v === 'object' && v !== null) states[path] = v;
      }
      if (Object.keys(states).length > 0) viewStates[gid] = states;
    }
  }

  const drafts: Record<string, { text: string; baseHash: string }> = {};
  if (typeof l.drafts === 'object' && l.drafts !== null) {
    for (const [path, v] of Object.entries(l.drafts as Record<string, unknown>)) {
      if (!all.has(path)) continue;
      const draft = sanitizeDraft(v);
      if (draft) drafts[path] = draft;
    }
  }

  return { groups, activeGroupId, viewStates, drafts };
}

/** Defensive validation for editor state loaded from localStorage.
 *  Accepts v1 documents (flat per-leaf tabs) and migrates them to v2 on read. */
export function sanitizeEditorState(value: unknown): WorktreeEditorState | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as { version?: unknown; leaves?: unknown };
  if (v.version !== 1 && v.version !== 2) return null;
  if (typeof v.leaves !== 'object' || v.leaves === null) return { version: 2, leaves: {} };

  const leaves: Record<string, LeafEditorState> = {};
  for (const [leafId, raw] of Object.entries(v.leaves as Record<string, unknown>)) {
    const state = sanitizeLeafState(raw);
    if (state) leaves[leafId] = state;
  }
  return { version: 2, leaves };
}

/** Replace one leaf's slice, keeping every other leaf's slice untouched. */
export function mergeLeafState(
  doc: WorktreeEditorState,
  leafId: string,
  state: LeafEditorState,
): WorktreeEditorState {
  return { ...doc, leaves: { ...doc.leaves, [leafId]: state } };
}

/** Drop slices for leaves that no longer exist. Returns `doc` unchanged (same reference) when nothing was removed. */
export function pruneLeaves(doc: WorktreeEditorState, liveLeafIds: string[]): WorktreeEditorState {
  const live = new Set(liveLeafIds);
  const entries = Object.entries(doc.leaves);
  if (entries.every(([id]) => live.has(id))) return doc;

  const leaves: Record<string, LeafEditorState> = {};
  for (const [id, state] of entries) {
    if (live.has(id)) leaves[id] = state;
  }
  return { ...doc, leaves };
}

/** djb2 string hash. Not cryptographic — used only to detect draft/file conflicts. */
export function hashText(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 33) ^ text.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

export const EDITOR_STATE_STORAGE_PREFIX = 'claude-deck.editorState.';
// layout/useTileLayout.ts のレイアウト永続化キー。依存方向を一方向に保つため
// (useTileLayout.ts → editorState.ts)、定数の定義はこちらに置く。
export const TILE_LAYOUT_STORAGE_PREFIX = 'claude-deck.tileLayout.';
// layout/termState.ts のターミナルグループ永続化キー。TILE_LAYOUT_STORAGE_PREFIX と
// 同じ理由でこちらに置く (layout/* → editorState.ts の一方向依存を保つため)。
export const TERM_STATE_STORAGE_PREFIX = 'claude-deck.termState.';

function emptyDoc(): WorktreeEditorState {
  return { version: 2, leaves: {} };
}

function loadDoc(worktreePath: string): WorktreeEditorState {
  try {
    const raw = localStorage.getItem(EDITOR_STATE_STORAGE_PREFIX + worktreePath);
    if (raw) {
      const parsed = sanitizeEditorState(JSON.parse(raw));
      if (parsed) return parsed;
    }
  } catch {
    // broken JSON / storage unavailable — fall through to an empty document
  }
  return emptyDoc();
}

function saveDoc(worktreePath: string, doc: WorktreeEditorState): void {
  try {
    localStorage.setItem(EDITOR_STATE_STORAGE_PREFIX + worktreePath, JSON.stringify(doc));
  } catch {
    // storage full / unavailable — state just won't persist
  }
}

export function loadLeafEditorState(worktreePath: string, leafId: string): LeafEditorState | null {
  return loadDoc(worktreePath).leaves[leafId] ?? null;
}

export function saveLeafEditorState(worktreePath: string, leafId: string, state: LeafEditorState): void {
  const doc = loadDoc(worktreePath);
  saveDoc(worktreePath, mergeLeafState(doc, leafId, state));
}

export function pruneEditorState(worktreePath: string, liveLeafIds: string[]): void {
  const doc = loadDoc(worktreePath);
  const pruned = pruneLeaves(doc, liveLeafIds);
  if (pruned !== doc) saveDoc(worktreePath, pruned);
}

export function removeWorktreeLocalState(worktreePath: string): void {
  try {
    localStorage.removeItem(EDITOR_STATE_STORAGE_PREFIX + worktreePath);
    localStorage.removeItem(TILE_LAYOUT_STORAGE_PREFIX + worktreePath);
    localStorage.removeItem(TERM_STATE_STORAGE_PREFIX + worktreePath);
  } catch {
    // storage unavailable
  }
}
