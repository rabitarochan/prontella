// ターミナルグループツリーの localStorage 永続化。editorState.ts の
// loadDoc / saveDoc / loadLeafEditorState / saveLeafEditorState /
// pruneEditorState と同型 (worktree ごとに 1 ドキュメント、leaf id で分割)。
//
// ストレージキーの接頭辞だけは editorState.ts 側に置いてある — 依存方向を
// 一方向に保つため (editorState.ts の TILE_LAYOUT_STORAGE_PREFIX と同じ理由)。

import { TERM_STATE_STORAGE_PREFIX } from '../editorState';
import { allTermGroups, sanitizeTermGroups, type TermGroupNode } from './termGroups';

export interface LeafTermState {
  groups: TermGroupNode;
  /** 常に groups 内に存在するグループ id */
  activeGroupId: string;
}

interface WorktreeTermState {
  version: 1;
  leaves: Record<string, LeafTermState>;
}

function emptyDoc(): WorktreeTermState {
  return { version: 1, leaves: {} };
}

/** localStorage から読んだ値の防御的検証。leaf スライス単位で捨てる。 */
export function sanitizeTermState(value: unknown): WorktreeTermState | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as { version?: unknown; leaves?: unknown };
  if (v.version !== 1) return null;
  if (typeof v.leaves !== 'object' || v.leaves === null) return null;

  const leaves: Record<string, LeafTermState> = {};
  for (const [leafId, raw] of Object.entries(v.leaves as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const slice = raw as { groups?: unknown; activeGroupId?: unknown };
    const groups = sanitizeTermGroups(slice.groups);
    if (!groups) continue;
    const all = allTermGroups(groups);
    const activeGroupId =
      typeof slice.activeGroupId === 'string' && all.some((g) => g.id === slice.activeGroupId)
        ? slice.activeGroupId
        : all[0].id;
    leaves[leafId] = { groups, activeGroupId };
  }
  return { version: 1, leaves };
}

function loadDoc(worktreePath: string): WorktreeTermState {
  try {
    const raw = localStorage.getItem(TERM_STATE_STORAGE_PREFIX + worktreePath);
    if (raw) {
      const parsed = sanitizeTermState(JSON.parse(raw));
      if (parsed) return parsed;
    }
  } catch {
    // broken JSON / storage unavailable — fall through to an empty document
  }
  return emptyDoc();
}

function saveDoc(worktreePath: string, doc: WorktreeTermState): void {
  try {
    localStorage.setItem(TERM_STATE_STORAGE_PREFIX + worktreePath, JSON.stringify(doc));
  } catch {
    // storage full / unavailable — state just won't persist
  }
}

export function loadLeafTermState(worktreePath: string, leafId: string): LeafTermState | null {
  return loadDoc(worktreePath).leaves[leafId] ?? null;
}

export function saveLeafTermState(
  worktreePath: string,
  leafId: string,
  state: LeafTermState,
): void {
  const doc = loadDoc(worktreePath);
  saveDoc(worktreePath, { ...doc, leaves: { ...doc.leaves, [leafId]: state } });
}

/** Drop slices for leaves that no longer exist. */
export function pruneTermState(worktreePath: string, liveLeafIds: string[]): void {
  const doc = loadDoc(worktreePath);
  const live = new Set(liveLeafIds);
  const entries = Object.entries(doc.leaves);
  if (entries.every(([id]) => live.has(id))) return;
  const leaves: Record<string, LeafTermState> = {};
  for (const [id, state] of entries) {
    if (live.has(id)) leaves[id] = state;
  }
  saveDoc(worktreePath, { ...doc, leaves });
}
