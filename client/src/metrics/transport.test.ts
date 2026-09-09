// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MetricRecord } from './registry.js';
import { createTransport, fitToLimit } from './transport.js';

describe('fitToLimit', () => {
  const rec = (k: string, t: number, pad = 0): MetricRecord => ({ k, t, ...(pad ? { p: 'x'.repeat(pad) } : {}) });

  it('keeps the latest snapshot first, then the newest events, and returns them in time order', () => {
    const records = [rec('snapshot', 1, 40), rec('slow', 2, 40), rec('snapshot', 3, 40), rec('stall', 4, 40), rec('slow', 5, 40)];
    // 最新 snapshot (t=3) + 新しい event 2 件 (t=5, t=4) がちょうど入り、古い 2 件は溢れる上限
    const limit = 16 + [records[2], records[3], records[4]].reduce((n, r) => n + JSON.stringify(r).length + 1, 0);
    const { kept, dropped } = fitToLimit(records, limit);
    expect(kept.map((r) => r.t)).toEqual([3, 4, 5]);
    expect(dropped).toBe(2);
  });

  it('skips a single record that is larger than the limit', () => {
    const { kept, dropped } = fitToLimit([rec('hang', 1, 500), rec('slow', 2)], 100);
    expect(kept.map((r) => r.k)).toEqual(['slow']);
    expect(dropped).toBe(1);
  });
});

describe('createTransport', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('batches on the interval, splitting bodies at the limit', async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
    });
    const transport = createTransport({ url: '/api/metrics/ingest', intervalMs: 1000, bodyLimit: 120, fetchImpl, listen: false });
    for (let i = 0; i < 6; i++) transport.push({ k: 'slow', t: i, n: 'http', ms: 1, p: 'x'.repeat(20) });
    expect(fetchImpl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(bodies.length).toBeGreaterThan(1);
    for (const body of bodies) {
      expect(body.length).toBeLessThanOrEqual(120 + 20); // 1 件目は上限を超えても入れる
      const parsed = JSON.parse(body) as { records: MetricRecord[] };
      expect(parsed.records.length).toBeGreaterThan(0);
    }
    const total = bodies.reduce((n, b) => n + (JSON.parse(b) as { records: unknown[] }).records.length, 0);
    expect(total).toBe(6);
    expect(transport.stats()).toMatchObject({ sent: 6, dropped: 0 });
    transport.stop();
  });

  it('sends via beacon on hide with truncation to the limit', () => {
    const sent: Blob[] = [];
    const beacon = vi.fn((_url: string, body: Blob) => {
      sent.push(body);
      return true;
    });
    const transport = createTransport({ url: '/x', intervalMs: 60_000, bodyLimit: 200, beacon, listen: false });
    for (let i = 0; i < 10; i++) transport.push({ k: 'slow', t: i, n: 'http', ms: 1, p: 'x'.repeat(30) });
    transport.push({ k: 'snapshot', t: 100, counters: [] });
    transport.flush('hide');
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(sent[0].size).toBeLessThanOrEqual(200);
    expect(transport.stats().truncated).toBeGreaterThan(0);
    transport.stop();
  });

  it('drops the oldest beyond maxQueue and counts fetch failures as dropped', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });
    const transport = createTransport({ url: '/x', intervalMs: 1000, maxQueue: 3, fetchImpl, listen: false });
    for (let i = 0; i < 5; i++) transport.push({ k: 'slow', t: i });
    expect(transport.stats().dropped).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.stats().dropped).toBe(5);
    transport.stop();
  });
});
