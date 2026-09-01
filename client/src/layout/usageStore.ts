// Claude のプラン使用量の共有ポーリング。データはアカウント全体で 1 つなので、
// ターミナルタイルを何枚開いても HTTP は 1 本に保つ:
// 購読者が 0 → 1 になったとき即時 fetch + インターバル開始、1 → 0 で停止する
// (参照カウント方式)。
//
// リセットまでの残り時間は resetsAt からクライアント側で計算する。表示先は
// ツールチップだけなので専用の時計は持たない — ポーリングごとの再描画
// (最大 60 秒遅れ) で分単位の表示には十分。

import { useEffect } from 'react';
import { create } from 'zustand';
import { api } from '../api';
import type { UsageSnapshot } from '../types';

/** 再取得の間隔。サーバー側にも 60 秒の TTL キャッシュがある。 */
const POLL_MS = 60_000;

interface UsageState {
  usage: UsageSnapshot | null;
  /** 初回取得がまだ終わっていない (CLI の初回起動で 15 秒ほどかかる)。 */
  loading: boolean;
  subscribers: number;
  timer: ReturnType<typeof setInterval> | null;
  refresh: () => Promise<void>;
  subscribe: () => void;
  unsubscribe: () => void;
}

export const useUsageStore = create<UsageState>((set, get) => ({
  usage: null,
  loading: false,
  subscribers: 0,
  timer: null,

  refresh: async () => {
    if (get().usage === null) set({ loading: true });
    try {
      set({ usage: await api.usage(), loading: false });
    } catch {
      // ネットワーク断など。前回の値を残したまま黙って諦める
      // (次のティックで取り直す)。
      set({ loading: false });
    }
  },

  subscribe: () => {
    set({ subscribers: get().subscribers + 1 });
    if (get().timer) return;
    // タイルの分割やレイアウト変更でバーが unmount → remount されると
    // 購読者数が一瞬 0 に落ちる。そこで毎回取り直すと余計なリクエストになるので、
    // 十分新しいスナップショットを既に持っているときは次のティックに任せる。
    const { usage } = get();
    if (!usage || Date.now() - usage.fetchedAt >= POLL_MS) void get().refresh();
    set({ timer: setInterval(() => void get().refresh(), POLL_MS) });
  },

  unsubscribe: () => {
    const next = Math.max(0, get().subscribers - 1);
    set({ subscribers: next });
    if (next > 0) return;
    const timer = get().timer;
    if (timer) clearInterval(timer);
    set({ timer: null });
  },
}));

/** 購読 (マウント中だけポーリングを生かす) + 現在のスナップショット。 */
export function useUsage(): { usage: UsageSnapshot | null; loading: boolean } {
  const usage = useUsageStore((s) => s.usage);
  const loading = useUsageStore((s) => s.loading);
  useEffect(() => {
    const { subscribe, unsubscribe } = useUsageStore.getState();
    subscribe();
    return unsubscribe;
  }, []);
  return { usage, loading };
}
