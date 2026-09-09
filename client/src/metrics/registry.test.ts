import { describe, expect, it } from 'vitest';
import { HIST_BUCKETS, Registry } from './registry.js';

describe('client Registry', () => {
  it('uses the same 24 doubling buckets from 0.05ms as the server registry', () => {
    // server/metrics/registry.ts の HIST_BUCKETS と同じ定義。集計 CLI が両者を同じ表に載せる前提。
    expect(HIST_BUCKETS).toEqual(Array.from({ length: 24 }, (_, i) => 0.05 * 2 ** i));
  });

  it('is inert while disabled and records once enabled', () => {
    const reg = new Registry({ defaultSlowMs: 0 });
    const events: unknown[] = [];
    reg.onEvent = (r) => events.push(r);
    const hidden = reg.counter('xterm.write.hidden.bytes');
    hidden.add(10);
    reg.recordSpan('http', 5, { route: '/api/repos', method: 'GET' });
    expect(reg.snapshot().counters[0].v).toBe(0);
    expect(events).toEqual([]);

    reg.enabled = true;
    hidden.add(10);
    reg.recordSpan('http', 5, { route: '/api/repos', method: 'GET' }, { status: 200 });
    const snap = reg.snapshot();
    expect(snap.counters[0]).toEqual({ n: 'xterm.write.hidden.bytes', v: 10 });
    expect(snap.hist[0]).toMatchObject({ n: 'http', l: { route: '/api/repos', method: 'GET' } });
    expect(events).toHaveLength(1);
    expect(events[0]).not.toHaveProperty('status'); // includeAttrs=false (anon)
  });
});
