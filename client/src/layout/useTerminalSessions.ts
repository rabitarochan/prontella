import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAgentEvents } from '../agentEvents';
import { api } from '../api';
import { normPath } from '../sessionLocate';
import { useDeck } from '../store';
import type { TerminalSession } from '../types';
import { recordSessionKinds } from './sessionKinds';

// /ws/events が死んでいる (半死ソケット等) ときの保険。通常はプッシュだけで顔ぶれが揃う。
const FALLBACK_POLL_MS = 30_000;

/**
 * Exposes the terminal sessions of a worktree plus create/kill.
 *
 * **顔ぶれも中身もプッシュ (/ws/events) が正**: サーバーは snapshot / session /
 * removed で全セッションの作成・更新・終了を流す (useAgentEvents)。以前は
 * `/api/terminals?cwd=` を 3 秒ごとにポーリングして顔ぶれを決めていたが、
 * プッシュで同じ情報が届いているので、ポーリングは (a) 初回表示を速くするための
 * 1 回と (b) プッシュが途絶えたときの 30 秒ごとの保険だけにした
 * (ページ数 × 3 秒ごとの HTTP とサーバーの list() を消す)。
 *
 * `sessions` はプッシュの snapshot か初回フェッチのどちらかが届くまで null。
 */
export function useTerminalSessions(cwd: string) {
  const refreshDeck = useDeck((s) => s.refresh);
  const [fetched, setFetched] = useState<TerminalSession[] | null>(null);
  const live = useAgentEvents((s) => s.sessions);
  const liveLoaded = useAgentEvents((s) => s.loaded);

  const reload = useCallback(async () => {
    try {
      const list = await api.terminals(cwd);
      // kind レジストリを先に更新してから公開する (終了後のタブ分類用)
      recordSessionKinds(list);
      setFetched(list);
    } catch {
      // server restart etc. — next poll will recover
    }
  }, [cwd]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer !== null) return;
      timer = setInterval(() => void reload(), FALLBACK_POLL_MS);
    };
    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };
    // ブラウザータブが非表示の間は保険のポーリングも止める。再表示の瞬間に 1 回同期する。
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

  // プッシュが揃っていればそれが顔ぶけ・中身の両方。揃う前は初回フェッチの結果に
  // プッシュ済みの中身を被せる (従来の合成)。
  const merged = useMemo(() => {
    if (liveLoaded) {
      const target = normPath(cwd);
      return Object.values(live).filter((s) => normPath(s.cwd) === target);
    }
    return fetched === null ? null : fetched.map((session) => live[session.id] ?? session);
  }, [cwd, fetched, live, liveLoaded]);

  // 終了後のタブ分類 (sessionKinds) はプッシュ由来のセッションにも効かせる
  useEffect(() => {
    if (merged) recordSessionKinds(merged);
  }, [merged]);

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

  return { sessions: merged, reload, create, createAgent, kill };
}
