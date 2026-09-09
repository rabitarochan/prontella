import { describe, expect, it } from 'vitest';
// @ts-expect-error — 依存なしの ESM スクリプト (型定義なし)。CLI と同じ純関数を直接検証する。
import { analyze, detectStorms, linearFit, parseJsonl, parseSince } from '../../scripts/metrics/lib/analyze.mjs';
// @ts-expect-error — 同上
import { renderMarkdown } from '../../scripts/metrics/lib/report.mjs';

/**
 * 集計 CLI の判別器 (傾き・ストーム・ムダ比) の真理値表。既知の値を持つ合成レコードで、
 * 陽性 (検出すべき) と陰性 (検出してはいけない) の両方を固定する。
 */

const RUN = 'a1b2c3d4';
const T0 = Date.UTC(2026, 8, 9, 0, 0, 0);
const H = 3_600_000;

function snapshot(t: number, extra: Record<string, unknown>): Record<string, unknown> {
  return { k: 'snapshot', t, run: RUN, src: 'server', up: (t - T0) / 1000, ...extra };
}

describe('parseJsonl', () => {
  it('skips a truncated last line and non-records, keeps the rest', () => {
    const text = '{"k":"meta","t":1}\n{"k":"snapshot","t":2}\n{"k":"snap';
    const { records, bad } = parseJsonl(text);
    expect(records.map((r: { k: string }) => r.k)).toEqual(['meta', 'snapshot']);
    expect(bad).toBe(1);
  });
});

describe('parseSince', () => {
  it('parses relative and absolute forms', () => {
    const now = 10 * H;
    expect(parseSince('2h', now)).toBe(8 * H);
    expect(parseSince('30m', now)).toBe(now - 30 * 60_000);
    expect(parseSince('1d', now)).toBe(now - 24 * H);
    expect(parseSince('2026-09-08', now)).toBe(Date.parse('2026-09-08'));
    expect(parseSince('nonsense', now)).toBeNull();
    expect(parseSince(undefined, now)).toBeNull();
  });
});

describe('linearFit', () => {
  it('recovers a known slope with R²=1 and returns null for too few points', () => {
    const fit = linearFit([[0, 100], [H, 120], [2 * H, 140], [3 * H, 160]]);
    expect(fit.slope * H).toBeCloseTo(20, 6);
    expect(fit.r2).toBeCloseTo(1, 6);
    expect(linearFit([[0, 1], [1, 2]])).toBeNull();
  });

  it('gives a low R² for noise around a flat line (negative control)', () => {
    const pts: [number, number][] = [];
    for (let i = 0; i < 40; i++) pts.push([i * H, 100 + (i % 2 === 0 ? 5 : -5)]);
    const fit = linearFit(pts);
    expect(Math.abs(fit.slope * H)).toBeLessThan(0.5);
    expect(fit.r2).toBeLessThan(0.2);
  });
});

describe('detectStorms', () => {
  const ws = (t: number, path = '/ws/term', tab = 'cafebabe') => ({ k: 'ws', t, run: RUN, src: 'client', tab, path, phase: 'reconnecting', attempt: 1 });

  it('detects 3 reconnects of one path within 10s', () => {
    const storms = detectStorms([ws(0), ws(4_000), ws(9_000)]);
    expect(storms).toHaveLength(1);
    expect(storms[0]).toMatchObject({ startT: 0, endT: 9_000, count: 3 });
  });

  it('does not flag 3 reconnects spread over 30s, nor 3 different paths (negative controls)', () => {
    expect(detectStorms([ws(0), ws(15_000), ws(30_000)])).toEqual([]);
    expect(detectStorms([ws(0, '/ws/term'), ws(1_000, '/ws/agent'), ws(2_000, '/ws/events')])).toEqual([]);
    expect(detectStorms([ws(0, '/ws/term', 'aaaaaaaa'), ws(1_000, '/ws/term', 'bbbbbbbb'), ws(2_000, '/ws/term', 'cccccccc')])).toEqual([]);
  });

  it('ignores non-reconnecting phases', () => {
    expect(detectStorms([{ ...ws(0), phase: 'open' }, { ...ws(1), phase: 'open' }, { ...ws(2), phase: 'open' }])).toEqual([]);
  });
});

describe('analyze', () => {
  const records = [
    { k: 'meta', t: T0, run: RUN, src: 'server', tier: 'dev', version: '0.2.0', node: 'v24.18.1', platform: 'win32', arch: 'x64', pid: 1 },
    // 4 時間で rss が 100 → 220 MB (30 MB/h、R²=1)、heapUsed は平坦
    ...[0, 1, 2, 3, 4].map((h) =>
      snapshot(T0 + h * H, {
        proc: { rss: 100 + 30 * h, heapUsed: 50, loop: { p50: 1, p99: h === 2 ? 250 : 5, max: h === 2 ? 1200 : 10 }, heap: { detachedCtx: h === 4 ? 1 : 0 }, handles: { Timeout: 2 + h } },
        app: { ptySessions: 2, sinkWritten: 10 * h, sinkDropped: 0, sinkFlushErrors: 0 },
        counters: [
          { n: 'pty.flush.bytes', v: 1000 * (h + 1) },
          { n: 'pty.flush.unwatched.bytes', v: 400 * (h + 1) },
          { n: 'pty.resize.changed', v: 10 },
          { n: 'pty.resize.noop', v: 30 },
          { n: 'repos.poll.changed', v: 5 },
          { n: 'repos.poll.unchanged', v: 95 },
          { n: 'events.broadcast', v: 100 },
          { n: 'events.noSubscribers', v: 25 },
        ],
        gauges: [],
        hist: [{ n: 'git', l: { git: 'status' }, h: { c: 10, sum: 500, min: 10, max: 200, p50: 51.2, p90: 102.4, p99: 204.8 } }],
      }),
    ),
    { k: 'slow', t: T0 + H, run: RUN, src: 'server', n: 'git', git: 'status', ms: 800 },
    { k: 'slow', t: T0 + 2 * H, run: RUN, src: 'server', n: 'git', git: 'status', ms: 1200 },
    { k: 'slow', t: T0 + 2 * H, run: RUN, src: 'server', n: 'http', route: '/api/git/diff', method: 'GET', ms: 300 },
    { k: 'hang', t: T0 + 2 * H, run: RUN, src: 'server', ms: 1500, recent: [{ n: 'git', t: 1, ph: 's' }] },
    // client tab: xterm 3 枚に canvas 9 = 3/xterm (⚠)、hidden 比 75%
    ...[0, 1, 2].map((h) => ({
      k: 'snapshot', t: T0 + h * H, run: RUN, src: 'client', tab: 'cafebabe', act: 'active',
      counters: [
        { n: 'xterm.write.visible.bytes', v: 1000 },
        { n: 'xterm.write.hidden.bytes', v: 3000 },
        { n: 'xterm.deferred.discarded.bytes', v: 2500 },
        { n: 'repos.poll.tick', l: { act: 'active' }, v: 10 },
        { n: 'repos.poll.tick', l: { act: 'inactive' }, v: 90 },
      ],
      gauges: [
        { n: 'xterm.instances', v: 3 },
        { n: 'canvas.count', v: 3 + 3 * h },
        { n: 'js.heap.used', v: 40 + 25 * h },
        { n: 'monaco.models', v: 4 },
        { n: 'tiles', v: 2 },
        { n: 'ws.links', v: 4 },
      ],
      hist: [],
    })),
    { k: 'hang', t: T0 + H, run: RUN, src: 'client', tab: 'cafebabe', ms: 700, attr: 'window', act: 'active', recent: [] },
    { k: 'stall', t: T0 + H, run: RUN, src: 'client', tab: 'cafebabe', ms: 300, act: 'active' },
    { k: 'ws', t: T0, run: RUN, src: 'client', tab: 'cafebabe', path: '/ws/term', phase: 'reconnecting', attempt: 1 },
    { k: 'ws', t: T0 + 2000, run: RUN, src: 'client', tab: 'cafebabe', path: '/ws/term', phase: 'reconnecting', attempt: 2 },
    { k: 'ws', t: T0 + 4000, run: RUN, src: 'client', tab: 'cafebabe', path: '/ws/term', phase: 'reconnecting', attempt: 3 },
    { k: 'session', t: T0, run: RUN, src: 'server', kind: 'pty', open: 1 },
    { k: 'session', t: T0 + H, run: RUN, src: 'server', kind: 'pty', open: 0, ageMs: H },
  ];

  it('computes memory slope, hang counts, waste ratios and storms with the expected values', () => {
    const [run] = analyze(records, { top: 5 });
    expect(run.id).toBe(RUN);
    expect(run.serverSnapshotCount).toBe(5);
    expect(run.memory.server.rss.slopePerHour).toBeCloseTo(30, 6);
    expect(run.memory.server.rss.r2).toBeCloseTo(1, 6);
    expect(run.memory.server.heapUsed.slopePerHour).toBeCloseTo(0, 6);
    expect(run.memory.server.detachedCtxMax).toBe(1);
    expect(run.memory.server.loop).toMatchObject({ p99Over100: 1, maxMs: 1200 });
    expect(run.hangs.server).toHaveLength(1);
    expect(run.hangs.client).toHaveLength(1);
    expect(run.hangs.stalls).toHaveLength(1);
    expect(run.waste.ptyUnwatchedRatio).toBeCloseTo(0.4, 6);
    expect(run.waste.resizeNoopRatio).toBeCloseTo(0.75, 6);
    expect(run.waste.reposPollUnchangedRatio).toBeCloseTo(0.95, 6);
    expect(run.waste.eventsNoSubscribersRatio).toBeCloseTo(0.25, 6);
    expect(run.waste.xtermHiddenRatio).toBeCloseTo(0.75, 6);
    expect(run.waste.xtermDeferredDiscardedBytes).toBe(2500);
    expect(run.waste.clientPollInactive).toBe(90);
    expect(run.waste.storms).toHaveLength(1);
    expect(run.waste.reconnects).toBe(3);
    const [client] = run.memory.client;
    expect(client.tab).toBe('cafebabe');
    expect(client.slopePerHour).toBeCloseTo(25, 6);
    expect(client.canvasPerXtermLast).toBeCloseTo(3, 6);
    expect(run.slowTop[0]).toMatchObject({ n: 'git', label: 'git status', count: 2, max: 1200, total: 2000 });
    expect(run.histTop[0]).toMatchObject({ n: 'git', c: 50, sum: 2500 });
    expect(run.sessions).toHaveLength(2);
  });

  it('renders every section and flags the growing series', () => {
    const runs = analyze(records, { top: 5 });
    const md = renderMarkdown(runs, { tier: 'dev', dir: 'X', bad: 0, files: 1 });
    for (const heading of ['1. Slow operations', '2. Memory trend', '3. Hang / stall signals', '4. Wasted work', '5. Sessions', '6. Metrics self-cost']) {
      expect(md).toContain(heading);
    }
    expect(md).toContain('rss ⚠ growing');
    expect(md).not.toContain('heapUsed ⚠');
    expect(md).toContain('+30.0 MB/h');
    expect(md).toContain('storms (≥3 in 10s): 1');
    expect(md).toContain('40.0%'); // unwatched ratio
    expect(md).toContain('3.00 ⚠'); // canvas per xterm
  });

  it('separates runs and tolerates records without run/src', () => {
    const runs = analyze([
      { k: 'snapshot', t: 1, counters: [], gauges: [], hist: [] },
      { k: 'snapshot', t: 2, run: 'ffffffff', src: 'server', counters: [], gauges: [], hist: [] },
    ]);
    expect(runs.map((r: { id: string }) => r.id)).toEqual(['unknown', 'ffffffff']);
    expect(runs[0].memory.server.rss.points).toBe(0);
  });
});
