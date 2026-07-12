import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useDeck } from '../store';
import type { TerminalSession } from '../types';

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
      setSessions(await api.terminals(cwd));
    } catch {
      // server restart etc. — next poll will recover
    }
  }, [cwd]);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(timer);
  }, [reload]);

  const create = useCallback(
    async (run?: string) => {
      const session = await api.createTerminal(cwd, run);
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

  return { sessions, reload, create, kill };
}
