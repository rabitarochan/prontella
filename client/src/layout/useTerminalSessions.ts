import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useDeck } from '../store';
import type { TerminalSession } from '../types';
import { recordSessionKinds } from './sessionKinds';

const POLL_MS = 3000;

/**
 * Polls terminal sessions for a worktree and exposes create/kill.
 * `sessions` is null until the first successful fetch; on fetch errors the
 * previous list is kept so a transient server hiccup does not flash dead UI.
 */
export function useTerminalSessions(cwd: string) {
  const refreshDeck = useDeck((s) => s.refresh);
  const [sessions, setSessions] = useState<TerminalSession[] | null>(null);

  const reload = useCallback(async () => {
    try {
      const list = await api.terminals(cwd);
      // kind レジストリを先に更新してから公開する (終了後のタブ分類用)
      recordSessionKinds(list);
      setSessions(list);
    } catch {
      // server restart etc. — next poll will recover
    }
  }, [cwd]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer !== null) return;
      timer = setInterval(() => void reload(), POLL_MS);
    };
    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };
    // ブラウザータブが非表示の間はポーリングを止める (App.tsx の deck ポーリングと同じ対応)。
    // 再表示された瞬間に即 reload() してから interval を再開する。
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        stop();
      } else {
        void reload();
        start();
      }
    };
    void reload();
    if (document.visibilityState !== 'hidden') start();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      stop();
    };
  }, [reload]);

  const create = useCallback(
    async (run?: string, place?: (session: TerminalSession) => void) => {
      const session = await api.createTerminal(cwd, run);
      // Let the caller claim the session (e.g. assign it to a tile) before the
      // reload publishes it — otherwise the layout adoption rule could grab it.
      place?.(session);
      await reload();
      await refreshDeck();
      return session;
    },
    [cwd, reload, refreshDeck],
  );

  const createAgent = useCallback(
    async (place?: (session: TerminalSession) => void, resume?: string) => {
      const session = await api.createAgent(cwd, resume);
      recordSessionKinds([session]);
      // Let the caller claim the session (e.g. assign it to a tile) before the
      // reload publishes it — otherwise the layout adoption rule could grab it.
      place?.(session);
      await reload();
      await refreshDeck();
      return session;
    },
    [cwd, reload, refreshDeck],
  );

  const kill = useCallback(
    async (id: string) => {
      await api.killTerminal(id);
      await reload();
      await refreshDeck();
    },
    [reload, refreshDeck],
  );

  return { sessions, reload, create, createAgent, kill };
}
