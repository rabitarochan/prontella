// Pure analysis over metrics JSONL records (no I/O). Used by summarize.mjs and its tests.
//
// Record model (server/metrics/names.ts):
//   { k: 'meta'|'snapshot'|'slow'|'hang'|'stall'|'rafgap'|'ws'|'session'|'self', t, run, src, tab?, ... }
//   snapshot: { proc?, app?, counters: [{n,l?,v}], gauges: [{n,l?,v}], hist: [{n,l?,h:{c,sum,min,max,p50,p90,p99}}] }
// Counters are cumulative per process (server) / per tab (client); histograms are per interval.

export function parseJsonl(text) {
  const out = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec === 'object' && typeof rec.k === 'string' && typeof rec.t === 'number') out.push(rec);
      else bad += 1;
    } catch {
      bad += 1; // クラッシュ時の途中行など
    }
  }
  return { records: out, bad };
}

/** `2h` / `30m` / `3d` / ISO 日付 を「この時刻以降」の epoch ms に変換する。 */
export function parseSince(value, now = Date.now()) {
  if (!value) return null;
  const m = /^(\d+)([mhd])$/.exec(value);
  if (m) {
    const n = Number(m[1]);
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
    return now - n * unit;
  }
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

export function labelKey(entry) {
  if (!entry.l) return entry.n;
  const keys = Object.keys(entry.l).sort();
  return entry.n + '{' + keys.map((k) => `${k}=${entry.l[k]}`).join(',') + '}';
}

/** 最小二乗の傾き (単位/ms) と R²。点が 3 未満なら null。 */
export function linearFit(points) {
  const n = points.length;
  if (n < 3) return null;
  // x は epoch ms (≈1.7e12) なので、平均を引いてから計算する (そのまま x² を足すと
  // 倍精度の桁落ちで傾きが 1e-5 程度ずれる)。
  let mx = 0, my = 0;
  for (const [x, y] of points) {
    mx += x; my += y;
  }
  mx /= n; my /= n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const [x, y] of points) {
    const dx = x - mx;
    const dy = y - my;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let ssRes = 0;
  for (const [x, y] of points) {
    const d = y - my - slope * (x - mx);
    ssRes += d * d;
  }
  const r2 = syy === 0 ? 1 : 1 - ssRes / syy;
  return { slope, intercept, r2 };
}

export function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

/** 同じ path の 'reconnecting' が windowMs 内に minCount 回以上 = ストーム。 */
export function detectStorms(wsEvents, { windowMs = 10_000, minCount = 3 } = {}) {
  const byKey = new Map();
  for (const e of wsEvents) {
    if (e.phase !== 'reconnecting') continue;
    const key = `${e.src ?? '?'}|${e.tab ?? '-'}|${e.path ?? '?'}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(e.t);
  }
  const storms = [];
  for (const [key, times] of byKey) {
    times.sort((a, b) => a - b);
    let start = 0;
    for (let i = 0; i < times.length; i++) {
      while (times[i] - times[start] > windowMs) start += 1;
      const count = i - start + 1;
      if (count >= minCount) {
        const last = storms[storms.length - 1];
        if (last && last.key === key && times[start] <= last.endT) {
          last.endT = times[i];
          last.count = Math.max(last.count, count);
        } else {
          storms.push({ key, startT: times[start], endT: times[i], count });
        }
      }
    }
  }
  return storms;
}

function pick(counters, name, labelFilter) {
  let total = 0;
  for (const c of counters) {
    if (c.n !== name) continue;
    if (labelFilter && !labelFilter(c.l ?? {})) continue;
    total += c.v;
  }
  return total;
}

/** 記録を run ごとに束ね、解析済みの構造を返す。 */
export function analyze(records, { top = 15 } = {}) {
  const runs = new Map();
  const runOf = (r) => {
    const id = r.run ?? 'unknown';
    if (!runs.has(id)) {
      runs.set(id, {
        id, meta: null, firstT: r.t, lastT: r.t, kinds: {}, srcs: {}, tabs: new Set(),
        serverSnapshots: [], clientSnapshots: new Map(), slow: [], hang: [], stall: [], rafgap: [], ws: [], session: [],
        histTotals: new Map(),
      });
    }
    const run = runs.get(id);
    run.firstT = Math.min(run.firstT, r.t);
    run.lastT = Math.max(run.lastT, r.t);
    run.kinds[r.k] = (run.kinds[r.k] ?? 0) + 1;
    const src = r.src ?? 'server';
    run.srcs[src] = (run.srcs[src] ?? 0) + 1;
    if (r.tab) run.tabs.add(r.tab);
    return run;
  };

  for (const r of records) {
    const run = runOf(r);
    switch (r.k) {
      case 'meta':
        run.meta = r;
        break;
      case 'snapshot': {
        if ((r.src ?? 'server') === 'server') run.serverSnapshots.push(r);
        else {
          const tab = r.tab ?? '-';
          if (!run.clientSnapshots.has(tab)) run.clientSnapshots.set(tab, []);
          run.clientSnapshots.get(tab).push(r);
        }
        for (const h of r.hist ?? []) {
          const key = `${r.src ?? 'server'}|${labelKey(h)}`;
          const agg = run.histTotals.get(key) ?? { n: h.n, l: h.l, src: r.src ?? 'server', c: 0, sum: 0, max: 0, p99s: [], p50s: [] };
          agg.c += h.h.c;
          agg.sum += h.h.sum;
          agg.max = Math.max(agg.max, h.h.max);
          agg.p99s.push(h.h.p99);
          agg.p50s.push(h.h.p50);
          run.histTotals.set(key, agg);
        }
        break;
      }
      case 'slow': run.slow.push(r); break;
      case 'hang': run.hang.push(r); break;
      case 'stall': run.stall.push(r); break;
      case 'rafgap': run.rafgap.push(r); break;
      case 'ws': run.ws.push(r); break;
      case 'session': run.session.push(r); break;
      default: break;
    }
  }

  const result = [];
  for (const run of runs.values()) {
    run.serverSnapshots.sort((a, b) => a.t - b.t);
    for (const list of run.clientSnapshots.values()) list.sort((a, b) => a.t - b.t);

    // ---- slow operations: group by (src, n, primary label)
    const slowGroups = new Map();
    for (const e of run.slow) {
      const label = e.route ? `${e.method ?? ''} ${e.route}`.trim() : e.git ? `git ${e.git}` : e.path ? e.path : '';
      const key = `${e.src ?? 'server'}|${e.n}|${label}`;
      const g = slowGroups.get(key) ?? { src: e.src ?? 'server', n: e.n, label, ms: [], worst: null };
      g.ms.push(e.ms);
      if (!g.worst || e.ms > g.worst.ms) g.worst = e;
      slowGroups.set(key, g);
    }
    const slowTop = [...slowGroups.values()]
      .map((g) => {
        const sorted = [...g.ms].sort((a, b) => a - b);
        return { ...g, count: sorted.length, total: sorted.reduce((a, b) => a + b, 0), p50: quantile(sorted, 0.5), p99: quantile(sorted, 0.99), max: sorted[sorted.length - 1] };
      })
      .sort((a, b) => b.total - a.total)
      .slice(0, top);

    const histTop = [...run.histTotals.values()]
      .map((h) => ({ ...h, mean: h.c ? h.sum / h.c : 0, p99: Math.max(...h.p99s), p50: quantile([...h.p50s].sort((a, b) => a - b), 0.5) }))
      .sort((a, b) => b.sum - a.sum)
      .slice(0, top);

    // ---- memory trend (server)
    const memory = { server: null, client: [] };
    const ss = run.serverSnapshots;
    if (ss.length > 0) {
      const series = (get) => ss.map((s) => [s.t, get(s)]).filter(([, v]) => typeof v === 'number');
      const fitOf = (get) => {
        const pts = series(get);
        const fit = linearFit(pts);
        return { first: pts[0]?.[1] ?? null, last: pts[pts.length - 1]?.[1] ?? null, max: Math.max(...pts.map((p) => p[1])), slopePerHour: fit ? fit.slope * 3_600_000 : null, r2: fit?.r2 ?? null, points: pts.length };
      };
      memory.server = {
        rss: fitOf((s) => s.proc?.rss),
        heapUsed: fitOf((s) => s.proc?.heapUsed),
        external: fitOf((s) => s.proc?.external),
        arrayBuffers: fitOf((s) => s.proc?.arrayBuffers),
        detachedCtxMax: Math.max(0, ...ss.map((s) => s.proc?.heap?.detachedCtx ?? 0)),
        handles: { first: ss[0].proc?.handles ?? null, last: ss[ss.length - 1].proc?.handles ?? null },
        app: { first: ss[0].app ?? null, last: ss[ss.length - 1].app ?? null },
        loop: { p99Over100: ss.filter((s) => (s.proc?.loop?.p99 ?? 0) > 100).length, maxMs: Math.max(0, ...ss.map((s) => s.proc?.loop?.max ?? 0)), eluMax: Math.max(0, ...ss.map((s) => s.proc?.elu ?? 0)), cpuPctMax: Math.max(0, ...ss.map((s) => s.proc?.cpuPct ?? 0)) },
      };
    }
    for (const [tab, list] of run.clientSnapshots) {
      const gauge = (s, name) => s.gauges?.find((g) => g.n === name)?.v;
      const pts = list.map((s) => [s.t, gauge(s, 'js.heap.used')]).filter(([, v]) => typeof v === 'number');
      const fit = linearFit(pts);
      const last = list[list.length - 1];
      const first = list[0];
      const ratio = (s) => {
        const xterm = gauge(s, 'xterm.instances') ?? 0;
        const canvas = gauge(s, 'canvas.count') ?? 0;
        return xterm > 0 ? canvas / xterm : null;
      };
      memory.client.push({
        tab, points: list.length,
        heapFirst: pts[0]?.[1] ?? null, heapLast: pts[pts.length - 1]?.[1] ?? null, slopePerHour: fit ? fit.slope * 3_600_000 : null, r2: fit?.r2 ?? null,
        gaugesFirst: Object.fromEntries((first.gauges ?? []).map((g) => [labelKey(g), g.v])),
        gaugesLast: Object.fromEntries((last.gauges ?? []).map((g) => [labelKey(g), g.v])),
        canvasPerXtermFirst: ratio(first), canvasPerXtermLast: ratio(last),
        webglLost: gauge(last, 'webgl.lost') ?? 0,
      });
    }

    // ---- wasted work (from last cumulative counters)
    const lastServer = ss[ss.length - 1]?.counters ?? [];
    const clientLast = [...run.clientSnapshots.values()].map((l) => l[l.length - 1].counters ?? []).flat();
    const ratio = (num, den) => (den > 0 ? num / den : null);
    const flushBytes = pick(lastServer, 'pty.flush.bytes');
    const hidden = pick(clientLast, 'xterm.write.hidden.bytes');
    const visible = pick(clientLast, 'xterm.write.visible.bytes');
    const waste = {
      ptyUnwatchedRatio: ratio(pick(lastServer, 'pty.flush.unwatched.bytes'), flushBytes),
      ptyFlushBytes: flushBytes,
      ptyBurstFlushes: pick(lastServer, 'pty.flush.burst'),
      resizeNoopRatio: ratio(pick(lastServer, 'pty.resize.noop'), pick(lastServer, 'pty.resize.noop') + pick(lastServer, 'pty.resize.changed')),
      activityCoalescedRatio: ratio(pick(lastServer, 'activity.coalesced'), pick(lastServer, 'activity.coalesced') + pick(lastServer, 'activity.publish')),
      eventsNoSubscribersRatio: ratio(pick(lastServer, 'events.noSubscribers'), pick(lastServer, 'events.broadcast')),
      wsSendSkipped: pick(lastServer, 'ws.send.skipped'),
      reposPollUnchangedRatio: ratio(pick(lastServer, 'repos.poll.unchanged'), pick(lastServer, 'repos.poll.unchanged') + pick(lastServer, 'repos.poll.changed')),
      reposPollGitCalls: pick(lastServer, 'repos.poll.gitCalls'),
      hookUnknownTerm: pick(lastServer, 'hook.unknownTerm'),
      xtermHiddenRatio: ratio(hidden, hidden + visible),
      xtermHiddenBytes: hidden,
      xtermDeferredDiscardedBytes: pick(clientLast, 'xterm.deferred.discarded.bytes'),
      xtermDeferredOverflow: pick(clientLast, 'xterm.deferred.overflow'),
      resizeFitPerSent: ratio(pick(clientLast, 'resize.fit'), pick(clientLast, 'resize.sent')),
      clientRefreshUnchangedRatio: ratio(pick(clientLast, 'repos.refresh.unchanged'), pick(clientLast, 'repos.refresh.unchanged') + pick(clientLast, 'repos.refresh.changed')),
      clientPollInactive: pick(clientLast, 'repos.poll.tick', (l) => l.act === 'inactive'),
      clientPollActive: pick(clientLast, 'repos.poll.tick', (l) => l.act === 'active'),
      storms: detectStorms(run.ws),
      reconnects: run.ws.length,
    };

    const self = {
      sinkDropped: ss[ss.length - 1]?.app?.sinkDropped ?? 0,
      sinkWritten: ss[ss.length - 1]?.app?.sinkWritten ?? 0,
      sinkFlushErrors: ss[ss.length - 1]?.app?.sinkFlushErrors ?? 0,
      scrubDropped: pick(lastServer, 'metrics.self.scrubDropped'),
      ingestDropped: pick(lastServer, 'metrics.self.ingestDropped'),
      serialize: run.histTotals.get('server|metrics.self.serialize') ?? null,
    };

    const hangs = {
      server: run.hang.filter((h) => (h.src ?? 'server') === 'server'),
      client: run.hang.filter((h) => h.src === 'client'),
      stalls: run.stall,
      rafgaps: run.rafgap,
    };

    result.push({
      id: run.id, meta: run.meta, firstT: run.firstT, lastT: run.lastT, kinds: run.kinds, srcs: run.srcs, tabs: [...run.tabs],
      serverSnapshotCount: ss.length, slowTop, histTop, memory, hangs, waste, self, sessions: run.session,
    });
  }
  result.sort((a, b) => a.firstT - b.firstT);
  return result;
}
