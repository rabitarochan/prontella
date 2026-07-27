// Per-worktree editor UI state (open tabs, active tab, Monaco view states, dirty drafts)
// persisted to localStorage, keyed by tile leaf id. Sibling of layout/useTileLayout.ts's
// WorktreeLayout persistence but a separate document, since which files are open is a
// property of a leaf's editor, not of the tile tree shape.

export type TabKind = 'editor' | 'preview';

/** Identifies one open tab. Tab identity is the `{kind, path}` pair, not `path` alone —
 *  an editor tab and a preview tab for the same path are distinct tabs. */
export interface OpenTabRef {
  kind: TabKind;
  path: string;
}

export interface LeafEditorState {
  /** worktree-root-relative paths, in tab order. Also accepts the legacy `string[]`
   *  shape on read (each entry treated as an `'editor'` tab) — see sanitizeOpenFiles. */
  openFiles: OpenTabRef[];
  /** Also accepts the legacy `activeFile: string` shape on read (treated as an
   *  `'editor'` tab) — see sanitizeLeafState. */
  activeTab: OpenTabRef | null;
  /** path -> opaque Monaco viewState JSON. Editor tabs only, keyed by path (unchanged) —
   *  a preview tab has no Monaco view state to persist. */
  viewStates: Record<string, unknown>;
  /** path -> unsaved edit, for dirty tabs only. Editor tabs only, keyed by path
   *  (unchanged) — preview tabs are never dirty. */
  drafts: Record<string, { text: string; baseHash: string }>;
}

export interface WorktreeEditorState {
  version: 1;
  /** key = tile leaf id */
  leaves: Record<string, LeafEditorState>;
}

const MAX_OPEN_FILES = 50;
// Matches server/files.ts's MAX_FILE_SIZE (2MB) so the invariant "any file the
// server will open has a draft size limit that can hold its full content"
// holds. If this were smaller than MAX_FILE_SIZE, an edited draft for a file
// near that size could be silently dropped on restore even though flush()
// happily wrote it (see FilesTab.tsx's flush(), which mirrors this same
// constant so writes and reads agree on the limit).
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
    const key = `${ref.kind}:${ref.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function sanitizeDraft(raw: unknown): { text: string; baseHash: string } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const d = raw as { text?: unknown; baseHash?: unknown };
  if (typeof d.text !== 'string' || typeof d.baseHash !== 'string') return null;
  if (d.text.length > MAX_DRAFT_TEXT_LENGTH) return null;
  return { text: d.text, baseHash: d.baseHash };
}

function sanitizeLeafState(raw: unknown): LeafEditorState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const l = raw as {
    openFiles?: unknown;
    activeFile?: unknown;
    activeTab?: unknown;
    viewStates?: unknown;
    drafts?: unknown;
  };

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

/** Defensive validation for editor state loaded from localStorage. */
export function sanitizeEditorState(value: unknown): WorktreeEditorState | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as { version?: unknown; leaves?: unknown };
  if (v.version !== 1) return null;
  if (typeof v.leaves !== 'object' || v.leaves === null) return { version: 1, leaves: {} };

  const leaves: Record<string, LeafEditorState> = {};
  for (const [leafId, raw] of Object.entries(v.leaves as Record<string, unknown>)) {
    const state = sanitizeLeafState(raw);
    if (state) leaves[leafId] = state;
  }
  return { version: 1, leaves };
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

function emptyDoc(): WorktreeEditorState {
  return { version: 1, leaves: {} };
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
  } catch {
    // storage unavailable
  }
}
