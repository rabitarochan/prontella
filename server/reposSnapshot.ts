/**
 * GET /api/repos の計算結果を「同時実行 1 本」に畳むためのスナップショットキャッシュ。
 *
 * なぜ必要か: /api/repos は 18 repo / 22 worktree で `git worktree list` と
 * `git status` を約 40 プロセス起動し、1 本で 3〜9 秒かかる。実測では同時数を
 * 1 : 3 : 5 : 8 と増やしても総スループットは一切上がらず、wall は 1.0 : 3.2 : 6.4 : 13.7 倍に
 * 悪化した (1 本でマシンが飽和している)。クライアントが応答より短い間隔でポーリング
 * していたため in-flight が最大 21 本まで積み上がり、1 リクエストが 40 秒超かかっていた。
 * 同時実行を 1 本に畳めば、レイテンシーはそのまま N 分の 1 に戻る。
 *
 * 鮮度の保証は TTL ではなく **epoch (世代カウンター)** が担う。コミット直後の
 * refresh に「コミット前に始まった計算」の結果を渡さないことが、この設計の存在理由。
 * epoch を進めるのは呼び出し側 (server/index.ts の変更系ミドルウェア) の責務。
 */

export interface SnapshotCache<T> {
  /** compute() の結果を epoch/TTL の条件下で再利用する。 */
  get(compute: () => Promise<T>): Promise<T>;
  /** 状態を変えうる操作の前後で呼ぶ。以後、旧 epoch の結果は再利用されない。 */
  invalidate(): void;
  /** テスト・診断用。 */
  stats(): { hits: number; joins: number; misses: number; epoch: number };
}

export function createSnapshotCache<T>(opts: {
  ttlMs: number;
  /** テストから時刻を注入する (既定は Date.now)。 */
  now?: () => number;
}): SnapshotCache<T> {
  const now = opts.now ?? Date.now;
  let epoch = 0;
  let inflight: { epoch: number; promise: Promise<T> } | null = null;
  let cached: { epoch: number; at: number; value: T } | null = null;
  let hits = 0;
  let joins = 0;
  let misses = 0;

  return {
    invalidate() {
      epoch += 1;
      // 両方落とす。epoch 判定だけでも再利用は防げるが、参照を残すとメモリと
      // 「まだ使えるのでは」という誤読の両方を招くため明示的に捨てる。
      cached = null;
      inflight = null;
    },

    stats() {
      return { hits, joins, misses, epoch };
    },

    get(compute) {
      // (1) キャッシュから返す: epoch が一致し、かつ TTL 内のときだけ。
      // age >= 0 を要求するのは、Windows で壁時計が巻き戻ったときに
      // 「経過が負 = 常に TTL 未満」となってエントリーが永久に fresh 判定される事故を防ぐため。
      if (cached !== null && cached.epoch === epoch) {
        const age = now() - cached.at;
        if (age >= 0 && age < opts.ttlMs) {
          hits += 1;
          return Promise.resolve(cached.value);
        }
      }

      // (2) 進行中に相乗りする: その計算が現在と同じ epoch で始まっているときだけ。
      // epoch が進んでいる = 途中で状態を変える操作が入った、なので相乗りさせてはいけない。
      if (inflight !== null && inflight.epoch === epoch) {
        joins += 1;
        return inflight.promise;
      }

      // (3) 新規に計算する。
      misses += 1;
      const startEpoch = epoch;
      const promise = compute().then(
        (value) => {
          // 計算中に epoch が進んでいたら結果はもう古い。待機者には返すが保存はしない。
          if (epoch === startEpoch) cached = { epoch: startEpoch, at: now(), value };
          if (inflight?.promise === promise) inflight = null;
          return value;
        },
        (err: unknown) => {
          // 失敗はキャッシュしない (次の get() が再試行する)。
          if (inflight?.promise === promise) inflight = null;
          throw err;
        },
      );
      // .then のコールバックは同期実行されないため、ここで代入しても取りこぼさない。
      inflight = { epoch: startEpoch, promise };
      return promise;
    },
  };
}
