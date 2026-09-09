// Markdown rendering of the analysis (scripts/metrics/lib/analyze.mjs). Sections are ordered by
// how actionable they are for a performance investigation with an AI agent reading the output.

const fmt = (v, digits = 1) => (v === null || v === undefined || Number.isNaN(v) ? '-' : typeof v === 'number' ? v.toFixed(digits) : String(v));
const pct = (v) => (v === null || v === undefined ? '-' : `${(v * 100).toFixed(1)}%`);
const iso = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 19);
const mb = (v) => (v === null || v === undefined ? '-' : `${v.toFixed(1)} MB`);
const dur = (ms) => {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(2)}h`;
};

function table(headers, rows) {
  if (rows.length === 0) return '_(none)_\n';
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n') + '\n';
}

function trendFlag(m) {
  if (!m || m.slopePerHour === null) return '';
  if (m.slopePerHour > 20 && m.r2 !== null && m.r2 > 0.6) return ' ⚠ growing';
  return '';
}

export function renderMarkdown(runs, { tier, dir, bad, files }) {
  const out = [];
  out.push(`# Prontella metrics summary (${tier})\n`);
  out.push(`- source: \`${dir}\` (${files} files, ${bad} unreadable lines)`);
  out.push(`- runs: ${runs.length}\n`);

  for (const run of runs) {
    const m = run.meta ?? {};
    out.push(`## Run \`${run.id}\` — ${iso(run.firstT)} → ${iso(run.lastT)} (${dur(run.lastT - run.firstT)})\n`);
    out.push(`- version ${m.version ?? '?'} · node ${m.node ?? '?'} · ${m.platform ?? '?'}/${m.arch ?? '?'} · pid ${m.pid ?? '?'}`);
    out.push(`- records: ${Object.entries(run.kinds).map(([k, v]) => `${k}=${v}`).join(', ')} · sources: ${Object.entries(run.srcs).map(([k, v]) => `${k}=${v}`).join(', ')} · tabs: ${run.tabs.length}`);
    out.push(`- server snapshots: ${run.serverSnapshotCount}\n`);

    // 1. slow operations
    out.push(`### 1. Slow operations (events over threshold, top by total time)\n`);
    out.push(table(
      ['src', 'name', 'label', 'count', 'p50 ms', 'p99 ms', 'max ms', 'total ms', 'worst attrs'],
      run.slowTop.map((g) => [g.src, g.n, g.label || '-', g.count, fmt(g.p50, 0), fmt(g.p99, 0), fmt(g.max, 0), fmt(g.total, 0), worstAttrs(g.worst)]),
    ));
    out.push(`\n**All timings (histograms, top by total time)**\n`);
    out.push(table(
      ['src', 'series', 'count', 'mean ms', 'p50 ms', 'p99 ms', 'max ms', 'total ms'],
      run.histTop.map((h) => [h.src, seriesLabel(h), h.c, fmt(h.mean, 2), fmt(h.p50, 2), fmt(h.p99, 1), fmt(h.max, 1), fmt(h.sum, 0)]),
    ));

    // 2. memory
    out.push(`\n### 2. Memory trend\n`);
    const s = run.memory.server;
    if (s) {
      out.push(table(
        ['server', 'first', 'last', 'max', 'slope /h', 'R²', 'points'],
        [['rss', s.rss], ['heapUsed', s.heapUsed], ['external', s.external], ['arrayBuffers', s.arrayBuffers]].map(([name, v]) => [
          name + trendFlag(v), mb(v.first), mb(v.last), mb(v.max), v.slopePerHour === null ? '-' : `${v.slopePerHour >= 0 ? '+' : ''}${v.slopePerHour.toFixed(1)} MB/h`, fmt(v.r2, 2), v.points,
        ]),
      ));
      out.push(`- detached V8 contexts (max): ${s.detachedCtxMax} · CPU max ${fmt(s.loop.cpuPctMax)}% · ELU max ${fmt(s.loop.eluMax, 2)}`);
      if (s.handles.first && s.handles.last) {
        const keys = new Set([...Object.keys(s.handles.first), ...Object.keys(s.handles.last)]);
        out.push(`- handles first→last: ${[...keys].map((k) => `${k} ${s.handles.first[k] ?? 0}→${s.handles.last[k] ?? 0}`).join(', ')}`);
      }
      if (s.app.first && s.app.last) {
        const keys = ['ptySessions', 'sdkSessions', 'ptySockets', 'sdkSockets', 'wsEvents', 'mirrorLines', 'sdkEvents'].filter((k) => k in s.app.last);
        out.push(`- app first→last: ${keys.map((k) => `${k} ${s.app.first[k] ?? 0}→${s.app.last[k] ?? 0}`).join(', ')}`);
      }
    } else out.push('_(no server snapshots)_');
    if (run.memory.client.length > 0) {
      out.push(`\n**Client tabs**\n`);
      out.push(table(
        ['tab', 'points', 'JS heap first', 'last', 'slope /h', 'R²', 'xterm', 'canvas/xterm', 'monaco models', 'tiles', 'ws links', 'webgl lost'],
        run.memory.client.map((c) => [
          c.tab, c.points, mb(c.heapFirst), mb(c.heapLast), c.slopePerHour === null ? '-' : `${c.slopePerHour >= 0 ? '+' : ''}${c.slopePerHour.toFixed(1)} MB/h${c.slopePerHour > 20 && c.r2 > 0.6 ? ' ⚠' : ''}`, fmt(c.r2, 2),
          `${c.gaugesFirst['xterm.instances'] ?? '-'}→${c.gaugesLast['xterm.instances'] ?? '-'}`,
          `${fmt(c.canvasPerXtermFirst, 2)}→${fmt(c.canvasPerXtermLast, 2)}${c.canvasPerXtermLast > 2 ? ' ⚠' : ''}`,
          `${c.gaugesFirst['monaco.models'] ?? '-'}→${c.gaugesLast['monaco.models'] ?? '-'}`,
          `${c.gaugesFirst.tiles ?? '-'}→${c.gaugesLast.tiles ?? '-'}`,
          `${c.gaugesFirst['ws.links'] ?? '-'}→${c.gaugesLast['ws.links'] ?? '-'}`,
          c.webglLost,
        ]),
      ));
    }

    // 3. hangs
    out.push(`\n### 3. Hang / stall signals\n`);
    const h = run.hangs;
    if (s) out.push(`- server event-loop: intervals with p99 > 100ms: ${s.loop.p99Over100} / ${run.serverSnapshotCount} · worst delay ${fmt(s.loop.maxMs, 0)} ms`);
    out.push(`- server hang events: ${h.server.length}${h.server.length ? ` (max ${Math.max(...h.server.map((e) => e.ms))} ms)` : ''}`);
    out.push(`- client long tasks ≥500ms: ${h.client.length}${h.client.length ? ` (max ${Math.max(...h.client.map((e) => e.ms))} ms)` : ''} · timer stalls: ${h.stalls.length} · rAF gaps: ${h.rafgaps.length}`);
    const worst = [...h.server, ...h.client].sort((a, b) => b.ms - a.ms).slice(0, 5);
    if (worst.length > 0) {
      out.push('');
      out.push(table(
        ['when', 'src', 'ms', 'attribution', 'active', 'recent spans (oldest→newest)'],
        worst.map((e) => [iso(e.t), e.src ?? 'server', e.ms, e.attr ?? '-', e.act ?? '-', (e.recent ?? []).slice(-8).map((sp) => `${sp.n}${sp.ph === 'e' ? `=${fmt(sp.ms, 0)}` : '…'}`).join(' ')]),
      ));
    }

    // 4. wasted work
    out.push(`\n### 4. Wasted work\n`);
    const w = run.waste;
    out.push(table(
      ['signal', 'value', 'note'],
      [
        ['PTY bytes flushed to sessions nobody watches', pct(w.ptyUnwatchedRatio), `of ${fmt(w.ptyFlushBytes / 1024, 0)} KB total`],
        ['PTY burst flushes', w.ptyBurstFlushes, 'pending exceeded MAX_PENDING'],
        ['PTY resize no-ops', pct(w.resizeNoopRatio), 'same cols/rows resent'],
        ['activity publishes coalesced', pct(w.activityCoalescedRatio), 'higher = the 250ms window is doing its job'],
        ['events broadcast with no subscribers', pct(w.eventsNoSubscribersRatio), 'JSON.stringify skipped since Phase 2'],
        ['ws.send skipped (socket not open)', w.wsSendSkipped, ''],
        ['GET /api/repos unchanged', pct(w.reposPollUnchangedRatio), `git calls ${w.reposPollGitCalls}`],
        ['hook events for unknown terminal', w.hookUnknownTerm, ''],
        ['xterm bytes written while hidden', pct(w.xtermHiddenRatio), `${fmt(w.xtermHiddenBytes / 1024, 0)} KB deferred`],
        ['deferred output discarded on snapshot', `${fmt(w.xtermDeferredDiscardedBytes / 1024, 0)} KB`, `overflow flushes ${w.xtermDeferredOverflow}`],
        ['fit() calls per resize sent', fmt(w.resizeFitPerSent, 1), 'throttle effectiveness'],
        ['client repos refresh unchanged', pct(w.clientRefreshUnchangedRatio), `poll ticks active ${w.clientPollActive} / inactive ${w.clientPollInactive}`],
        ['ws reconnects', w.reconnects, `storms (≥3 in 10s): ${w.storms.length}`],
      ],
    ));
    if (w.storms.length > 0) {
      out.push(table(['storm', 'start', 'end', 'count'], w.storms.map((st) => [st.key, iso(st.startT), iso(st.endT), st.count])));
    }

    // 5. sessions
    if (run.sessions.length > 0) {
      const opened = run.sessions.filter((e) => e.open === 1).length;
      const closed = run.sessions.filter((e) => e.open === 0);
      out.push(`\n### 5. Sessions\n`);
      out.push(`- opened ${opened} · closed ${closed.length}${closed.length ? ` · mean lifetime ${dur(closed.reduce((a, e) => a + (e.ageMs ?? 0), 0) / closed.length)}` : ''}`);
    }

    // 6. self cost
    out.push(`\n### 6. Metrics self-cost\n`);
    const sc = run.self;
    out.push(`- sink: written ${sc.sinkWritten}, dropped ${sc.sinkDropped}, flush errors ${sc.sinkFlushErrors} · scrub dropped ${sc.scrubDropped} · ingest dropped ${sc.ingestDropped}`);
    if (sc.serialize) out.push(`- snapshot serialize: ${sc.serialize.c} samples, mean ${fmt(sc.serialize.sum / sc.serialize.c, 2)} ms, max ${fmt(sc.serialize.max, 1)} ms`);
    out.push('');
  }
  return out.join('\n');
}

function seriesLabel(h) {
  if (!h.l) return h.n;
  return `${h.n} {${Object.entries(h.l).map(([k, v]) => `${k}=${v}`).join(', ')}}`;
}

function worstAttrs(e) {
  if (!e) return '-';
  const skip = new Set(['k', 't', 'n', 'ms', 'run', 'src', 'tab', 'route', 'method', 'git', 'path']);
  const parts = Object.entries(e).filter(([k]) => !skip.has(k)).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  const text = parts.join(' ');
  return text.length > 80 ? text.slice(0, 77) + '…' : text || '-';
}
