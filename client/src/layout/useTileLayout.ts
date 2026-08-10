import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import type { TerminalSession } from '../types';
import { pruneEditorState, TILE_LAYOUT_STORAGE_PREFIX } from '../editorState';
import {
  adoptSessions,
  appendSession,
  createDefaultLayout,
  findLeaf,
  leaves,
  makeLeaf,
  moveLeaf,
  normalize,
  pruneSessions,
  removeLeaf,
  removeSession,
  sanitize,
  setSizes,
  splitLeaf,
  swapLeaves,
  updateLeaf,
  type TileView,
  type TileNode,
  type WorktreeLayout,
} from './tileTree';

/** タイル DnD のドロップ先ゾーン。上下左右 = その方向へ分割挿入、center = 位置交換。 */
export type TileDropZone = 'left' | 'right' | 'top' | 'bottom' | 'center';

function loadLayout(worktreePath: string): WorktreeLayout {
  try {
    const raw = localStorage.getItem(TILE_LAYOUT_STORAGE_PREFIX + worktreePath);
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
  /**
   * Create a chat (Agent SDK) session as a new tab. Target: explicit leaf,
   * else the focused leaf, else the first chat-view leaf. Switches the tile
   * to the chat view and activates the new tab.
   */
  openChat: (leafId?: string) => Promise<void>;
  /**
   * DnD でのレイアウト再構成: src タイルを target の上下左右へ分割挿入、
   * または center で位置交換。中身は leaf.id 追従の Portal なので remount しない。
   */
  move: (srcId: string, targetId: string, zone: TileDropZone) => void;
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
  createAgentSession: (place?: (s: TerminalSession) => void) => Promise<TerminalSession>,
): TileActions {
  const t = useT();
  const [layout, setLayout] = useState<WorktreeLayout>(() => loadLayout(worktreePath));
  const [focusedLeafId, setFocusedLeafId] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(TILE_LAYOUT_STORAGE_PREFIX + worktreePath, JSON.stringify(layout));
    } catch {
      // storage full / unavailable — layout just won't persist
    }
    // タイル閉鎖やレイアウト初期化(reset)で消えた leaf の editorState スライスを回収する
    pruneEditorState(worktreePath, layout.root ? leaves(layout.root).map((l) => l.id) : []);
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
      return adoptSessions(pruned, sessions, focusedRef.current);
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
        if (!confirm(t('tile.closeSessionsConfirm', { n: alive.length }))) return;
        for (const id of alive) await killSession(id);
      }
      update(removeLeaf(layoutRef.current.root ?? root, leafId));
    },
    [killSession, t, update],
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

  const openChat = useCallback(
    async (leafId?: string) => {
      // Reserve the target leaf first so the chat lands where the user expects.
      let root = layoutRef.current.root;
      let targetId: string;
      if (!root) {
        const leaf = makeLeaf('chat');
        update(leaf);
        targetId = leaf.id;
      } else {
        const all = leaves(root);
        const target =
          all.find((l) => l.id === leafId) ??
          all.find((l) => l.id === focusedRef.current) ??
          all.find((l) => l.view === 'chat') ??
          all[0];
        targetId = target.id;
        update(updateLeaf(root, targetId, (leaf) => ({ ...leaf, view: 'chat' })));
      }
      setFocusedLeafId(targetId);
      await createAgentSession((session) => {
        // Claim the session before the reload publishes it — otherwise the
        // adoption rule could place it in another leaf.
        const current = layoutRef.current.root;
        if (current) update(appendSession(current, targetId, session.id));
      });
    },
    [createAgentSession, update],
  );

  const move = useCallback(
    (srcId: string, targetId: string, zone: TileDropZone) => {
      const root = layoutRef.current.root;
      if (!root || srcId === targetId) return;
      if (zone === 'center') {
        update(swapLeaves(root, srcId, targetId));
      } else {
        const dir = zone === 'left' || zone === 'right' ? 'row' : 'column';
        const before = zone === 'left' || zone === 'top';
        update(moveLeaf(root, srcId, targetId, dir, before));
      }
      setFocusedLeafId(srcId);
    },
    [update],
  );

  const applySizes = useCallback((splitId: string, sizes: number[]) => {
    const root = layoutRef.current.root;
    if (!root) return;
    setLayout((prev) => ({ ...prev, root: prev.root ? setSizes(prev.root, splitId, sizes) : null }));
  }, []);

  const reset = useCallback(() => {
    // Re-adopt live sessions immediately so terminals reappear without
    // waiting for the next poll tick.
    setLayout(adoptSessions(createDefaultLayout(), sessionsRef.current ?? [], null));
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
    openChat,
    move,
    applySizes,
    reset,
  };
}
