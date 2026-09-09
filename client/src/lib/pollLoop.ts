/**
 * 「前回が終わってから次を予約する」チェーン式のポーリングループ。
 *
 * setInterval だと **前回が終わったかを見ずに** 発火するため、1 回の処理が間隔より
 * 長くなった瞬間からリクエストが無限に積み上がる。GET /api/repos は git を約 40
 * プロセス起動する重い処理で、実測では in-flight が 21 本まで積み上がり、
 * 1 リクエストが 40 秒超かかっていた (同時数を増やしてもスループットは上がらないので、
 * 積み上がりはそのままレイテンシーの倍率になる)。
 *
 * 現行の useEffect 内実装から意味論を変えずに切り出したもの。タイマーと時計を
 * 注入できるようにしてあるのは、このリポジトリーに jsdom もコンポーネントテストも
 * 無く (vitest.config.ts の include は純ロジックのみ)、useEffect の中に置いたままだと
 * 構造上テストできないため。lib/latestThrottle.ts と同じ流儀。
 */
type TimerHandle = ReturnType<typeof setTimeout>;

export interface PollLoop {
  /** 初回を即時に 1 回走らせ、以後チェーンで回す。 */
  start(): void;
  /**
   * 望ましい間隔が変わった契機で呼ぶ (可視性・フォーカスの変化)。
   * 間隔が変わっていなければ何もしない (保留中のタイマーをリセットしない)。
   * kick=true なら即時に 1 回走らせる (再表示・フォーカス復帰)。
   */
  apply(kick: boolean): void;
  /** unmount 用。以後、進行中の run が終わっても再予約しない。 */
  stop(): void;
}

export function createPollLoop(opts: {
  run: () => Promise<unknown>;
  /** 望ましい間隔 (ms)。0 は「止める」(非表示タブ)。呼ぶたびに評価される。 */
  delayMs: () => number;
  timers?: {
    setTimeout: (fn: () => void, ms: number) => TimerHandle;
    clearTimeout: (handle: TimerHandle) => void;
  };
  now?: () => number;
}): PollLoop {
  const timers = opts.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  };
  const now = opts.now ?? Date.now;

  let timer: TimerHandle | null = null;
  let running = false;
  let stopped = false;
  // 直近に観測した「望ましい間隔」。apply() はこれと比べて、変化が無ければ何もしない
  // (現行実装の currentMs ガードと等価)。-1 は「未観測」。
  let currentMs = -1;
  let lastDurationMs = 0;

  const clear = () => {
    if (timer === null) return;
    timers.clearTimeout(timer);
    timer = null;
  };

  // 実行が間隔より長引く環境でもデューティ比が 50% を超えないよう、
  // 前回の所要時間を下限にする。速い環境では素の間隔と同じ。
  const nextDelay = (ms: number) => Math.max(ms, lastDurationMs);

  const arm = (ms: number) => {
    clear();
    if (ms === 0) return;
    timer = timers.setTimeout(fire, nextDelay(ms));
  };

  const schedule = () => {
    clear();
    if (stopped || running) return;
    currentMs = opts.delayMs();
    arm(currentMs);
  };

  function fire(): void {
    timer = null;
    if (stopped || running) return;
    running = true;
    const startedAt = now();
    // run() は **同期で** 呼ぶ。Promise.resolve().then(run) にすると初回取得が
    // マイクロタスク 1 つ分ずれ、現行実装 (useEffect 内の `void refresh()`) と
    // 挙動が変わる。
    let settled: Promise<unknown>;
    try {
      settled = Promise.resolve(opts.run());
    } catch {
      // run が同期 throw した場合も次の予約は続ける
      settled = Promise.resolve();
    }
    void settled
      // run 側の失敗でループを止めない (store.refresh が内部で捕まえることに依存しない)。
      .catch(() => undefined)
      .then(() => {
        lastDurationMs = Math.max(0, now() - startedAt);
        running = false;
        schedule();
      });
  }

  return {
    start() {
      stopped = false;
      currentMs = opts.delayMs();
      // 初回は間隔を待たずに走る (現行の `void refresh()` 相当)。非表示で
      // マウントされた場合も 1 回だけ取得するのは現行と同じ。
      fire();
    },
    apply(kick) {
      if (stopped) return;
      const ms = opts.delayMs();
      if (ms === currentMs) return;
      currentMs = ms;
      clear();
      // 実行中なら何もしない。settle 時の schedule() が新しい間隔を読む。
      if (running) return;
      if (kick && ms !== 0) {
        fire();
        return;
      }
      arm(ms);
    },
    stop() {
      stopped = true;
      clear();
    },
  };
}
