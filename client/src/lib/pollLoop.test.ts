import { describe, expect, it, vi } from 'vitest';
import { createPollLoop } from './pollLoop';

/** 手動で進めるタイマー。setTimeout の予約を 1 件ずつ検分できる。 */
function fakeTimers() {
  let seq = 0;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  return {
    api: {
      setTimeout: (fn: () => void, ms: number) => {
        seq += 1;
        pending.set(seq, { fn, ms });
        return seq as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: (handle: ReturnType<typeof setTimeout>) => {
        pending.delete(handle as unknown as number);
      },
    },
    /** 予約中のタイマー (0 or 1 件のはず)。 */
    armed: () => [...pending.values()],
    /** 予約されている遅延 (ms)。未予約なら null。 */
    armedMs: () => (pending.size === 0 ? null : [...pending.values()][0].ms),
    /** 予約を発火する。 */
    run: () => {
      const [id] = [...pending.keys()];
      if (id === undefined) throw new Error('予約されたタイマーがありません');
      const entry = pending.get(id)!;
      pending.delete(id);
      entry.fn();
    },
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** マイクロタスクを流す (run の settle 後の再予約を待つ)。 */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('createPollLoop', () => {
  it('start() は間隔を待たずに 1 回走らせる', async () => {
    const t = fakeTimers();
    const run = vi.fn(() => Promise.resolve());
    const loop = createPollLoop({ run, delayMs: () => 1000, timers: t.api });
    loop.start();
    expect(run).toHaveBeenCalledTimes(1);
    await flush();
    expect(t.armedMs()).toBe(1000); // settle 後に次を予約
  });

  it('run が完了するまで次のタイマーを張らない (二重発火しない)', async () => {
    const t = fakeTimers();
    const d = deferred();
    const run = vi.fn(() => d.promise);
    const loop = createPollLoop({ run, delayMs: () => 1000, timers: t.api });

    loop.start();
    await flush();
    expect(t.armed()).toHaveLength(0); // 進行中は予約なし
    expect(run).toHaveBeenCalledTimes(1);

    d.resolve();
    await flush();
    expect(t.armedMs()).toBe(1000);

    t.run();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('進行中に apply() が来ても新規発火しない', async () => {
    const t = fakeTimers();
    const d = deferred();
    const run = vi.fn(() => d.promise);
    let ms = 1000;
    const loop = createPollLoop({ run, delayMs: () => ms, timers: t.api });

    loop.start();
    await flush();
    ms = 4000;
    loop.apply(true); // kick だが進行中
    expect(run).toHaveBeenCalledTimes(1);

    d.resolve();
    await flush();
    expect(t.armedMs()).toBe(4000); // settle 時に新しい間隔を読む
  });

  it('delayMs() が 0 なら予約しない (非表示タブ)', async () => {
    const t = fakeTimers();
    const run = vi.fn(() => Promise.resolve());
    let ms = 0;
    const loop = createPollLoop({ run, delayMs: () => ms, timers: t.api });

    loop.start();
    expect(run).toHaveBeenCalledTimes(1); // 初回は非表示でも 1 回だけ走る (現行と同じ)
    await flush();
    expect(t.armed()).toHaveLength(0);

    ms = 1000;
    loop.apply(true); // 再表示
    expect(run).toHaveBeenCalledTimes(2);
    await flush();
    expect(t.armedMs()).toBe(1000);
  });

  it('可視だが非表示へ移ると、予約を落として止まる', async () => {
    const t = fakeTimers();
    const run = vi.fn(() => Promise.resolve());
    let ms = 1000;
    const loop = createPollLoop({ run, delayMs: () => ms, timers: t.api });

    loop.start();
    await flush();
    expect(t.armedMs()).toBe(1000);

    ms = 0;
    loop.apply(false);
    expect(t.armed()).toHaveLength(0);
  });

  it('間隔が変わっていない apply() は保留中のタイマーをリセットしない', async () => {
    const t = fakeTimers();
    const run = vi.fn(() => Promise.resolve());
    const loop = createPollLoop({ run, delayMs: () => 1000, timers: t.api });

    loop.start();
    await flush();
    const before = t.armed()[0];
    loop.apply(false);
    loop.apply(true);
    expect(t.armed()[0]).toBe(before); // 同一オブジェクト = 張り替えていない
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('stop() 後は進行中の run が終わっても再予約しない', async () => {
    const t = fakeTimers();
    const d = deferred();
    const run = vi.fn(() => d.promise);
    const loop = createPollLoop({ run, delayMs: () => 1000, timers: t.api });

    loop.start();
    await flush();
    loop.stop();
    d.resolve();
    await flush();
    expect(t.armed()).toHaveLength(0);
    loop.apply(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('run が reject してもループは止まらない', async () => {
    const t = fakeTimers();
    const run = vi.fn(() => Promise.reject(new Error('取得失敗')));
    const loop = createPollLoop({ run, delayMs: () => 1000, timers: t.api });

    loop.start();
    await flush();
    expect(t.armedMs()).toBe(1000);
    t.run();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('次回の遅延は max(間隔, 前回の所要時間)', async () => {
    const t = fakeTimers();
    let clock = 0;
    const d = deferred();
    const run = vi.fn(() => d.promise);
    const loop = createPollLoop({ run, delayMs: () => 1000, timers: t.api, now: () => clock });

    loop.start();
    clock = 9000; // 9 秒かかった
    d.resolve();
    await flush();
    expect(t.armedMs()).toBe(9000); // 間隔 1000 より所要 9000 が勝つ
  });
});
