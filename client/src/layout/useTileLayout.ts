import { useCallback, useEffect, useRef, useState } from 'react';
import type { TerminalSession } from '../types';
import {
  adoptSessions,
  createDefaultLayout,
  leaves,
  makeLeaf,
  normalize,
  removeLeaf,
  sanitize,
  setLeafContent,
  setSizes,
  splitLeaf,
  type TileContent,
  type TileNode,
  type WorktreeLayout,
} from './tileTree';

const STORAGE_PREFIX = 'claude-deck.tileLayout.';

function loadLayout(worktreePath: string): WorktreeLayout {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + worktreePath);
    if (raw) {
      const parsed = sanitize(JSON.parse(raw));
      if (parsed) return parsed;
    }
  } catch {
    // broken JSON / storage unavailable — fall through to the default
  }
  return createDefaultLayout();
}

export interface TileActions {
  layout: WorktreeLayout;
  focusedLeafId: string | null;
  focusLeaf: (leafId: string) => void;
  /** Split a leaf; the new tile starts as an empty picker. */
  split: (leafId: string, dir: 'row' | 'column') => void;
  /** Close a tile. Kills the terminal session (with confirm) if one is alive. */
  close: (leafId: string) => Promise<void>;
  /** Resolve an empty tile's picker choice. */
  pick: (leafId: string, choice: 'shell' | 'claude' | 'files' | 'git') => Promise<void>;
  /** Replace a dead terminal tile's session in place. */
  relaunch: (leafId: string, run?: string) => Promise<void>;
  /** Header shortcuts: focus the existing tile or open a new one. */
  openContent: (kind: 'files' | 'git') => void;
  openTerminal: (run?: string) => Promise<void>;
  /** Persist pane sizes after a drag. */
  applySizes: (splitId: string, sizes: number[]) => void;
  /** Back to the default layout (escape hatch for broken layouts). */
  reset: () => void;
}

export function useTileLayout(
  worktreePath: string,
  sessions: TerminalSession[] | null,
  createSession: (run?: string, place?: (s: TerminalSession) => void) => Promise<TerminalSession>,
  killSession: (id: string) => Promise<void>,
): TileActions {
  const [layout, setLayout] = useState<WorktreeLayout>(() => loadLayout(worktreePath));
  const [focusedLeafId, setFocusedLeafId] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_PREFIX + worktreePath, JSON.stringify(layout));
    } catch {
      // storage full / unavailable — layout just won't persist
    }
  }, [worktreePath, layout]);

  // Handlers read the latest tree through a ref so rapid successive actions
  // never operate on a stale closure.
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const update = useCallback((root: TileNode | null) => {
    setLayout((prev) => ({ ...prev, root: normalize(root) }));
  }, []);

  // Adopt sessions created outside the layout (other browser tab, stale layout).
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  useEffect(() => {
    if (!sessions) return;
    setLayout((prev) => adoptSessions(prev, sessions.map((s) => s.id)));
  }, [sessions]);

  const focusLeaf = useCallback((leafId: string) => setFocusedLeafId(leafId), []);

  const split = useCallback(
    (leafId: string, dir: 'row' | 'column') => {
      const root = layoutRef.current.root;
      if (!root) return;
      const result = splitLeaf(root, leafId, dir, { kind: 'empty' });
      update(result.root);
      setFocusedLeafId(result.newLeafId);
    },
    [update],
  );

  const close = useCallback(
    async (leafId: string) => {
      const root = layoutRef.current.root;
      if (!root) return;
      const target = leaves(root).find((l) => l.id === leafId);
      if (!target) return;
      if (target.content.kind === 'terminal') {
        const sessionId = target.content.sessionId;
        const alive = sessions?.some((s) => s.id === sessionId) ?? false;
        if (alive) {
          if (!confirm('このターミナルを終了しますか?')) return;
          await killSession(sessionId);
        }
      }
      update(removeLeaf(layoutRef.current.root ?? root, leafId));
    },
    [sessions, killSession, update],
  );

  const placeSession = useCallback(
    (leafId: string) => (session: TerminalSession) => {
      const root = layoutRef.current.root;
      if (root) {
        update(setLeafContent(root, leafId, { kind: 'terminal', sessionId: session.id }));
      }
    },
    [update],
  );

  const pick = useCallback(
    async (leafId: string, choice: 'shell' | 'claude' | 'files' | 'git') => {
      const root = layoutRef.current.root;
      if (!root) return;
      if (choice === 'files' || choice === 'git') {
        update(setLeafContent(root, leafId, { kind: choice }));
        return;
      }
      await createSession(choice === 'claude' ? 'claude' : undefined, placeSession(leafId));
    },
    [createSession, placeSession, update],
  );

  const relaunch = useCallback(
    async (leafId: string, run?: string) => {
      await createSession(run, placeSession(leafId));
    },
    [createSession, placeSession],
  );

  const openContent = useCallback(
    (kind: 'files' | 'git') => {
      const root = layoutRef.current.root;
      const existing = leaves(root).find((l) => l.content.kind === kind);
      if (existing) {
        setFocusedLeafId(existing.id);
        return;
      }
      const content: TileContent = { kind };
      if (!root) {
        const l = makeLeaf(content);
        update(l);
        setFocusedLeafId(l.id);
        return;
      }
      const empty = leaves(root).find((l) => l.content.kind === 'empty');
      if (empty) {
        update(setLeafContent(root, empty.id, content));
        setFocusedLeafId(empty.id);
        return;
      }
      const anchor = leaves(root).find((l) => l.id === focusedLeafId) ?? leaves(root)[0];
      const result = splitLeaf(root, anchor.id, 'row', content);
      update(result.root);
      setFocusedLeafId(result.newLeafId);
    },
    [focusedLeafId, update],
  );

  const openTerminal = useCallback(
    async (run?: string) => {
      const root = layoutRef.current.root;
      // Reserve a leaf first so the terminal lands where the user expects.
      let leafId: string;
      if (!root) {
        const l = makeLeaf({ kind: 'empty' });
        update(l);
        leafId = l.id;
      } else {
        const empty = leaves(root).find((l) => l.content.kind === 'empty');
        if (empty) {
          leafId = empty.id;
        } else {
          const anchor = leaves(root).find((l) => l.id === focusedLeafId) ?? leaves(root)[0];
          const result = splitLeaf(root, anchor.id, 'column', { kind: 'empty' });
          update(result.root);
          leafId = result.newLeafId;
        }
      }
      setFocusedLeafId(leafId);
      await createSession(run, placeSession(leafId));
    },
    [createSession, focusedLeafId, placeSession, update],
  );

  const applySizes = useCallback((splitId: string, sizes: number[]) => {
    const root = layoutRef.current.root;
    if (!root) return;
    setLayout((prev) => ({ ...prev, root: prev.root ? setSizes(prev.root, splitId, sizes) : null }));
  }, []);

  const reset = useCallback(() => {
    // Re-adopt live sessions immediately so terminals reappear without
    // waiting for the next poll tick.
    const ids = (sessionsRef.current ?? []).map((s) => s.id);
    setLayout(adoptSessions(createDefaultLayout(), ids));
    setFocusedLeafId(null);
  }, []);

  return {
    layout,
    focusedLeafId,
    focusLeaf,
    split,
    close,
    pick,
    relaunch,
    openContent,
    openTerminal,
    applySizes,
    reset,
  };
}
