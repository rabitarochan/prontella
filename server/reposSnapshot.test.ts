import { describe, expect, it, vi } from 'vitest';
import { createSnapshotCache } from './reposSnapshot.js';

/** 解決タイミングを手で制御できる Promise (計算の途中に invalidate を挟むため)。 */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 注入用の可変時計。 */
function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('createSnapshotCache: single-flight', () => {
  it('同時に来た 2 本の get() で compute は 1 回しか走らない', async () => {
    const d = deferred<string>();
    const compute = vi.fn(() => d.promise);
    const cache = createSnapshotCache<string>({ ttlMs: 1000, now: clock().now });

    const a = cache.get(compute);
    const b = cache.get(compute);
    d.resolve('snap');

    expect(await a).toBe('snap');
    expect(await b).toBe('snap');
    expect(compute).toHaveBeenCalledTimes(1);
    expect(cache.stats().joins).toBe(1);
  });

  it('計算完了後は inflight が解放され、TTL 切れなら次の get() が再計算する', async () => {
    const c = clock();
    let n = 0;
    const compute = vi.fn(() => Promise.resolve(`snap${(n += 1)}`));
    const cache = createSnapshotCache<string>({ ttlMs: 1000, now: c.now });

    expect(await cache.get(compute)).toBe('snap1');
    c.advance(1000); // ちょうど TTL = 期限切れ (age < ttl が条件)
    expect(await cache.get(compute)).toBe('snap2');
    expect(compute).toHaveBeenCalledTimes(2);
  });
});

describe('createSnapshotCache: epoch による鮮度保証', () => {
  it('invalidate を挟むと 2 本目は 1 本目の進行中の結果を受け取らない', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const compute = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const cache = createSnapshotCache<string>({ ttlMs: 1000, now: clock().now });

    const a = cache.get(compute);
    cache.invalidate(); // ここが「コミットが起きた」瞬間
    const b = cache.get(compute);

    first.resolve('before-commit');
    second.resolve('after-commit');

    expect(await a).toBe('before-commit');
    expect(await b).toBe('after-commit'); // 相乗りしていないこと
    expect(compute).toHaveBeenCalledTimes(2);
    expect(cache.stats().joins).toBe(0);
  });

  it('計算中に invalidate されたら待機者には結果を返すがキャッシュはしない', async () => {
    const c = clock();
    const first = deferred<string>();
    const compute = vi.fn().mockReturnValueOnce(first.promise).mockReturnValue(Promise.resolve('fresh'));
    const cache = createSnapshotCache<string>({ ttlMs: 10_000, now: c.now });

    const a = cache.get(compute);
    cache.invalidate();
    first.resolve('stale');
    expect(await a).toBe('stale'); // 自分が投げた計算なので受け取ってよい

    // TTL は十分残っているが、古い結果は保存されていないので再計算になる
    expect(await cache.get(compute)).toBe('fresh');
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('invalidate 後は TTL 内でもキャッシュヒットしない', async () => {
    const c = clock();
    let n = 0;
    const compute = vi.fn(() => Promise.resolve(`snap${(n += 1)}`));
    const cache = createSnapshotCache<string>({ ttlMs: 10_000, now: c.now });

    expect(await cache.get(compute)).toBe('snap1');
    c.advance(1); // TTL 内
    expect(await cache.get(compute)).toBe('snap1'); // ヒット
    cache.invalidate();
    expect(await cache.get(compute)).toBe('snap2'); // ミス
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 2 });
  });
});

describe('createSnapshotCache: TTL', () => {
  it('TTL 内はキャッシュから返し compute を呼ばない', async () => {
    const c = clock();
    const compute = vi.fn(() => Promise.resolve('snap'));
    const cache = createSnapshotCache<string>({ ttlMs: 1000, now: c.now });

    await cache.get(compute);
    c.advance(999);
    await cache.get(compute);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(cache.stats().hits).toBe(1);
  });

  it('時刻を打つのは計算完了時なので、計算に TTL 以上かかっても直後はヒットする', async () => {
    const c = clock();
    const d = deferred<string>();
    const compute = vi.fn(() => d.promise);
    const cache = createSnapshotCache<string>({ ttlMs: 1000, now: c.now });

    const a = cache.get(compute);
    c.advance(5000); // 計算に 5 秒かかった
    d.resolve('snap');
    await a;

    await cache.get(compute); // 完了直後
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('壁時計が巻き戻っても (age が負) キャッシュを fresh 扱いしない', async () => {
    const c = clock();
    let n = 0;
    const compute = vi.fn(() => Promise.resolve(`snap${(n += 1)}`));
    const cache = createSnapshotCache<string>({ ttlMs: 10_000, now: c.now });

    expect(await cache.get(compute)).toBe('snap1');
    c.advance(-60_000); // NTP 同期などで時計が巻き戻った
    expect(await cache.get(compute)).toBe('snap2');
  });

  it('ttlMs = 0 でも single-flight は成立する (キャッシュだけ無効)', async () => {
    const d = deferred<string>();
    let n = 0;
    const compute = vi.fn(() => (n === 0 ? ((n += 1), d.promise) : Promise.resolve('again')));
    const cache = createSnapshotCache<string>({ ttlMs: 0, now: clock().now });

    const a = cache.get(compute);
    const b = cache.get(compute);
    d.resolve('snap');
    expect(await a).toBe('snap');
    expect(await b).toBe('snap');
    expect(compute).toHaveBeenCalledTimes(1);

    expect(await cache.get(compute)).toBe('again'); // 完了後はヒットしない
  });
});

describe('createSnapshotCache: 失敗の扱い', () => {
  it('reject はキャッシュされず、次の get() が再試行する', async () => {
    const compute = vi
      .fn()
      .mockReturnValueOnce(Promise.reject(new Error('git 失敗')))
      .mockReturnValue(Promise.resolve('snap'));
    const cache = createSnapshotCache<string>({ ttlMs: 10_000, now: clock().now });

    await expect(cache.get(compute)).rejects.toThrow('git 失敗');
    expect(await cache.get(compute)).toBe('snap');
  });

  it('相乗りした待機者にも同じエラーが渡る (unhandled rejection を出さない)', async () => {
    const d = deferred<string>();
    const compute = vi.fn(() => d.promise);
    const cache = createSnapshotCache<string>({ ttlMs: 10_000, now: clock().now });

    const a = cache.get(compute);
    const b = cache.get(compute);
    const err = new Error('git 失敗');
    d.reject(err);

    await expect(a).rejects.toBe(err);
    await expect(b).rejects.toBe(err);
    expect(compute).toHaveBeenCalledTimes(1);
  });
});
