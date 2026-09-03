/**
 * 「最新値だけを、最短でも interval ms に 1 回」届けるスロットル。
 *
 * ターミナルの resize 送信用: セパレーターのドラッグ中は ResizeObserver が毎フレーム
 * 発火し、そのたびに PTY をリサイズすると ConPTY と TUI (Claude Code の Ink) が
 * 全画面を描き直してカクつく。ローカルの fit は即時に行い、サーバーへ送る値だけを
 * ここで間引く。トレーリング (最後の値は必ず届く) で、途中の値は捨てる。
 */
export interface LatestThrottle<T> {
  /** 値を積む。interval 内なら後で最新値だけが送られる。 */
  push(value: T): void;
  /** 積んだ値を今すぐ送る (再接続・アクティブ復帰など待てないとき)。 */
  flush(): void;
  /** 積んだ値を捨ててタイマーを止める (unmount)。 */
  cancel(): void;
}

export function createLatestThrottle<T>(
  send: (value: T) => void,
  intervalMs: number,
  timers: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  } = globalThis,
): LatestThrottle<T> {
  let pending: { value: T } | null = null;
  let timer: unknown = null;
  const fire = () => {
    timer = null;
    if (!pending) return;
    const { value } = pending;
    pending = null;
    send(value);
  };
  return {
    push(value) {
      pending = { value };
      if (timer === null) timer = timers.setTimeout(fire, intervalMs);
    },
    flush() {
      if (timer !== null) {
        timers.clearTimeout(timer);
        timer = null;
      }
      fire();
    },
    cancel() {
      if (timer !== null) {
        timers.clearTimeout(timer);
        timer = null;
      }
      pending = null;
    },
  };
}
