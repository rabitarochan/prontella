import { useCallback, useEffect, useRef, useState } from 'react';
import type { TerminalSession } from '../types';
import {
  adoptSessions,
  appendSession,
  createDefaultLayout,
  findLeaf,
  leaves,
  makeLeaf,
  normalize,
  pruneSessions,
  removeLeaf,
  removeSession,
  sanitize,
  setSizes,
  splitLeaf,
  updateLeaf,
  type TileView,
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
  /** Split a leaf; the new tile starts as an empty terminal view. */
  split: (leafId: string, dir: 'row' | 'column') => void;
  /** Close a tile. Kills its live terminal sessions (with confirm). */
  close: (leafId: string) => Promise<void>;
  /** Switch which view (files / git / term) a tile shows. */
  setView: (leafId: string, view: TileView) => void;
  /** Activate a terminal tab within a tile. */
  setActiveSession: (leafId: string, sessionId: string) => void;
  /** Close a terminal tab: kills the session if alive, then removes the tab. */
  closeSessionTab: (leafId: string, sessionId: string) => Promise<void>;
  /**
   * Create a terminal session as a new tab. Target: explicit leaf, else the
   * focused leaf, else the first term-view leaf. Switches the tile to the
   * terminal view and activates the new tab.
   */
  openTerminal: (run?: string, leafId?: string) => Promise<void>;
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
  const focusedRef = useRef(focusedLeafId);
  focusedRef.current = focusedLeafId;

  const update = useCallback((root: TileNode | null) => {
    setLayout((prev) => ({ ...prev, root: normalize(root) }));
  }, []);

  // Reconcile sessions into the tree:
  // - once per page load, drop persisted session ids that are no longer alive
  //   (sessions that die later keep their tab so the last output stays visible)
  // - adopt sessions no leaf owns yet (created from another browser tab etc.)
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const prunedRef = useRef(false);
  useEffect(() => {
    if (!sessions) return;
    const ids = sessions.map((s) => s.id);
    setLayout((prev) => {
      const pruned = prunedRef.current ? prev : pruneSessions(prev, ids);
      prunedRef.current = true;
      return adoptSessions(pruned, ids, focusedRef.current);
    });
  }, [sessions]);

  const focusLeaf = useCallback((leafId: string) => setFocusedLeafId(leafId), []);

  const split = useCallback(
    (leafId: string, dir: 'row' | 'column') => {
      const root = layoutRef.current.root;
      if (!root) return;
      const result = splitLeaf(root, leafId, dir, 'term');
      update(result.root);
      setFocusedLeafId(result.newLeafId);
    },
    [update],
  );

  const close = useCallback(
    async (leafId: string) => {
      const root = layoutRef.current.root;
      if (!root) return;
      const target = findLeaf(root, leafId);
      if (!target) return;
      const alive = target.sessions.filter((id) => sessionsRef.current?.some((s) => s.id === id));
      if (alive.length > 0) {
        if (!confirm(`このタイルを閉じますか? (ターミナル ${alive.length} 件を終了します)`)) return;
        for (const id of alive) await killSession(id);
      }
      update(removeLeaf(layoutRef.current.root ?? root, leafId));
    },
    [killSession, update],
  );

  const setView = useCallback(
    (leafId: string, view: TileView) => {
      const root = layoutRef.current.root;
      if (!root) return;
      update(updateLeaf(root, leafId, (leaf) => (leaf.view === view ? leaf : { ...leaf, view })));
      setFocusedLeafId(leafId);
    },
    [update],
  );

  const setActiveSession = useCallback(
    (leafId: string, sessionId: string) => {
      const root = layoutRef.current.root;
      if (!root) return;
      update(
        updateLeaf(root, leafId, (leaf) =>
          leaf.activeSession === sessionId ? leaf : { ...leaf, activeSession: sessionId },
        ),
      );
    },
    [update],
  );

  const closeSessionTab = useCallback(
    async (leafId: string, sessionId: string) => {
      if (sessionsRef.current?.some((s) => s.id === sessionId)) {
        await killSession(sessionId);
      }
      const root = layoutRef.current.root;
      if (root) update(removeSession(root, leafId, sessionId));
    },
    [killSession, update],
  );

  const openTerminal = useCallback(
    async (run?: string, leafId?: string) => {
      // Reserve the target leaf first so the terminal lands where the user expects.
      let root = layoutRef.current.root;
      let targetId: string;
      if (!root) {
        const leaf = makeLeaf('term');
        update(leaf);
        targetId = leaf.id;
      } else {
        const all = leaves(root);
        const target =
          all.find((l) => l.id === leafId) ??
          all.find((l) => l.id === focusedRef.current) ??
          all.find((l) => l.view === 'term') ??
          all[0];
        targetId = target.id;
        update(updateLeaf(root, targetId, (leaf) => ({ ...leaf, view: 'term' })));
      }
      setFocusedLeafId(targetId);
      await createSession(run, (session) => {
        // Claim the session before the reload publishes it — otherwise the
        // adoption rule could place it in another leaf.
        const current = layoutRef.current.root;
        if (current) update(appendSession(current, targetId, session.id));
      });
    },
    [createSession, update],
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
    setLayout(adoptSessions(createDefaultLayout(), ids, null));
    setFocusedLeafId(null);
  }, []);

  return {
    layout,
    focusedLeafId,
    focusLeaf,
    split,
    close,
    setView,
    setActiveSession,
    closeSessionTab,
    openTerminal,
    applySizes,
    reset,
  };
}
