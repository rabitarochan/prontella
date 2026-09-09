import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { HIST_BUCKETS, Registry, type MetricRecord } from './registry.js';

function enabled(opts?: ConstructorParameters<typeof Registry>[0]): { reg: Registry; events: MetricRecord[] } {
  const reg = new Registry(opts);
  reg.enabled = true;
  const events: MetricRecord[] = [];
  reg.onEvent = (r) => events.push(r);
  return { reg, events };
}

describe('Registry (disabled)', () => {
  it('records nothing and emits nothing while disabled', () => {
    const reg = new Registry();
    const events: MetricRecord[] = [];
    reg.onEvent = (r) => events.push(r);
    const c = reg.counter('http');
    c.add(5);
    reg.count('git');
    reg.gauge('tiles', 3);
    reg.observe('http', 10);
    reg.histogram('git').observe(1);
    const end = reg.startSpan('http');
    expect(end()).toBe(0);
    reg.recordSpan('http', 9999);
    reg.event('hang', { ms: 1 });
    expect(reg.withSpan('git', () => 42)).toBe(42);
    const snap = reg.snapshot();
    // ハンドルの取得で系列は登録されるが値は動かない
    expect(snap.counters.every((s) => s.v === 0)).toBe(true);
    expect(snap.gauges).toEqual([]);
    expect(snap.hist).toEqual([]);
    expect(events).toEqual([]);
  });
});

describe('Registry counters / gauges', () => {
  it('handles and count() share the same series; labels form separate series', () => {
    const { reg } = enabled();
    const h = reg.counter('pty.flush');
    h.add();
    h.add(2);
    reg.count('pty.flush', 3);
    reg.count('http', 1, { route: '/api/repos', method: 'GET' });
    reg.count('http', 1, { method: 'GET', route: '/api/repos' }); // 同じラベル、順序違い
    reg.count('http', 1, { route: '/api/repos', method: 'POST' });
    const { counters } = reg.snapshot();
    expect(counters).toEqual([
      { n: 'pty.flush', v: 6 },
      { n: 'http', l: { route: '/api/repos', method: 'GET' }, v: 2 },
      { n: 'http', l: { route: '/api/repos', method: 'POST' }, v: 1 },
    ]);
    // カウンターは累積 (snapshot でリセットしない)
    expect(reg.snapshot().counters[0].v).toBe(6);
  });

  it('gauge keeps the last value', () => {
    const { reg } = enabled();
    reg.gauge('tiles', 1);
    reg.gauge('tiles', 4);
    reg.gauge('ws.open', 2, { path: '/ws/term' });
    expect(reg.snapshot().gauges).toEqual([
      { n: 'tiles', v: 4 },
      { n: 'ws.open', l: { path: '/ws/term' }, v: 2 },
    ]);
  });
});

describe('Registry histograms', () => {
  it('bucket bounds double from 0.05ms', () => {
    expect(HIST_BUCKETS).toHaveLength(24);
    expect(HIST_BUCKETS[0]).toBe(0.05);
    expect(HIST_BUCKETS[1]).toBe(0.1);
    expect(HIST_BUCKETS[23]).toBeCloseTo(0.05 * 2 ** 23);
  });

  it('summarizes a known distribution and resets after snapshot', () => {
    const { reg } = enabled();
    // 1..100 ms を 1 回ずつ
    for (let v = 1; v <= 100; v++) reg.observe('http', v);
    const [entry] = reg.snapshot().hist;
    expect(entry.n).toBe('http');
    expect(entry.h.c).toBe(100);
    expect(entry.h.sum).toBe(5050);
    expect(entry.h.min).toBe(1);
    expect(entry.h.max).toBe(100);
    // バケット推定: p50 の真値 50 は (25.6, 51.2] のバケット → 上限 51.2
    expect(entry.h.p50).toBeCloseTo(51.2, 3);
    // p90 の真値 90 は (51.2, 102.4] → 上限は max で切り詰めて 100
    expect(entry.h.p90).toBe(100);
    expect(entry.h.p99).toBe(100);
    // snapshot 後は空 (c=0 の系列は出さない)
    expect(reg.snapshot().hist).toEqual([]);
  });

  it('percentile never leaves [min, max]', () => {
    const { reg } = enabled();
    reg.observe('git', 0.001);
    reg.observe('git', 0);
    reg.observe('git', 1e9); // 最終バケット超過
    const [entry] = reg.snapshot().hist;
    expect(entry.h.min).toBe(0);
    expect(entry.h.max).toBe(1e9);
    expect(entry.h.p50).toBeGreaterThanOrEqual(0);
    expect(entry.h.p50).toBeLessThanOrEqual(1e9);
    expect(entry.h.p99).toBe(1e9);
  });
});

describe('Registry spans', () => {
  it('startSpan measures, records into the histogram, and ends only once', () => {
    // perf_hooks の performance.now は vi.useFakeTimers で止まらないので実時間で待つ
    const { reg, events } = enabled({ defaultSlowMs: 1000 });
    const end = reg.startSpan('git', { git: 'status' });
    const until = performance.now() + 5;
    while (performance.now() < until) {
      /* spin */
    }
    const ms = end();
    expect(ms).toBeGreaterThanOrEqual(5);
    expect(end()).toBeGreaterThanOrEqual(ms); // 2 回目は計測だけ返し、記録しない
    const [entry] = reg.snapshot().hist;
    expect(entry).toMatchObject({ n: 'git', l: { git: 'status' } });
    expect(entry.h.c).toBe(1);
    expect(events).toEqual([]);
    const spans = reg.recentSpans();
    expect(spans.map((s) => s.ph)).toEqual(['s', 'e']);
  });

  it('emits a slow event at or above the per-name threshold, with labels only unless includeAttrs', () => {
    const { reg, events } = enabled({ slowMs: { git: 500 }, defaultSlowMs: 250 });
    reg.recordSpan('git', 499, { git: 'status' }, { cwd: 'C:\\secret' });
    reg.recordSpan('http', 250, { route: '/api/repos', method: 'GET' }, { status: 200 });
    reg.recordSpan('git', 500, { git: 'log' }, { cwd: 'C:\\secret' });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ k: 'slow', n: 'http', ms: 250, route: '/api/repos', method: 'GET' });
    expect(events[0]).not.toHaveProperty('status');
    expect(events[1]).toMatchObject({ k: 'slow', n: 'git', ms: 500, git: 'log' });
    expect(events[1]).not.toHaveProperty('cwd');

    reg.includeAttrs = true;
    reg.recordSpan('git', 600, { git: 'log' }, { cwd: 'C:\\secret' });
    expect(events[2]).toMatchObject({ cwd: 'C:\\secret' });
  });

  it('withSpan measures sync results, sync throws, and async rejections without swallowing', async () => {
    const { reg, events } = enabled({ defaultSlowMs: 0 });
    reg.includeAttrs = true;
    expect(reg.withSpan('git', () => 7)).toBe(7);
    expect(() => reg.withSpan('git', () => { throw new Error('x'); })).toThrow('x');
    await expect(reg.withSpan('git', () => Promise.resolve(9))).resolves.toBe(9);
    await expect(reg.withSpan('git', () => Promise.reject(new Error('y')))).rejects.toThrow('y');
    expect(events.map((e) => e.err)).toEqual([undefined, true, undefined, true]);
    expect(reg.snapshot().hist[0].h.c).toBe(4);
  });

  it('event() attaches devFields only when includeAttrs', () => {
    const { reg, events } = enabled();
    reg.event('session', { kind: 'pty' }, { cwd: 'C:\\x' });
    reg.includeAttrs = true;
    reg.event('session', { kind: 'pty' }, { cwd: 'C:\\x' });
    expect(events[0]).toEqual({ k: 'session', t: expect.any(Number), kind: 'pty' });
    expect(events[1]).toMatchObject({ kind: 'pty', cwd: 'C:\\x' });
  });

  it('recentSpans keeps the newest entries in order when the ring wraps', () => {
    const { reg } = enabled({ spanRingSize: 4, defaultSlowMs: Infinity });
    for (let i = 0; i < 6; i++) reg.recordSpan('git', i);
    expect(reg.recentSpans().map((s) => s.ms)).toEqual([2, 3, 4, 5]);
  });
});
