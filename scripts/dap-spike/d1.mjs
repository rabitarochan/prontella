// Phase 0 spike D1-D9: vscode-js-debug の dapDebugServer.js を TCP で叩き、
// 起動・ハンドシェイク順序・startDebugging 子セッション・BP 検証・ステップ時間・後始末を測る。
// Usage: SPIKE_DAP=<path to dapDebugServer.js> node scripts/dap-spike/d1.mjs [program] [options]
//   SPIKE_CONSOLE=integratedTerminal  D9: runInTerminal が来るか
//   SPIKE_NO_CHILD_BP=1               D3: 子セッションに BP を送らないと止まるか
//   SPIKE_KILL=1                      D7: disconnect の代わりに adapter を kill して debuggee が孤児になるか
//   SPIKE_RUNTIME_ARGS="--import tsx" D6: runtimeArgs
//   SPIKE_DISCONNECT=root             D7: root セッションだけに disconnect (既定は child → root)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const dap = process.env.SPIKE_DAP;
if (!dap) throw new Error('SPIKE_DAP を指定してください');
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const program = path.resolve(process.argv[2] ?? path.join(here, 'fixture/app.js'));
const root = path.resolve(process.env.SPIKE_ROOT ?? path.dirname(program));
const bpLine = fs.readFileSync(program, 'utf8').split('\n').findIndex((l) => l.includes('// BP')) + 1;
const t0 = performance.now();
const ms = () => Math.round(performance.now() - t0);
const log = (...a) => console.log(`[${String(ms()).padStart(6)}ms]`, ...a);

// ---- D1: spawn + listening 行 ----------------------------------------------
const adapter = spawn(process.execPath, [dap, '0', '127.0.0.1'], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
adapter.stderr.on('data', (d) => process.stderr.write('[adapter stderr] ' + d));
const port = await new Promise((res, rej) => {
  let out = '';
  adapter.stdout.on('data', (d) => {
    out += d;
    log('adapter stdout:', JSON.stringify(String(d)));
    const m = /listening at ([^:\s]+):(\d+)/.exec(out);
    if (m) res(Number(m[2]));
  });
  adapter.on('exit', (c) => rej(new Error('adapter exited ' + c)));
  setTimeout(() => rej(new Error('listening timeout')), 15_000);
});
log('D1 listening port', port, 'pid', adapter.pid);

// ---- DAP 接続 ----------------------------------------------------------------
const outputCats = new Map();
let stoppedResolvers = [];
const conns = [];
function connect(name) {
  const sock = net.connect({ host: '127.0.0.1', port });
  const c = { name, sock, seq: 1, pending: new Map(), events: [], onReverse: null };
  conns.push(c);
  let buf = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const hdrEnd = buf.indexOf('\r\n\r\n');
      if (hdrEnd < 0) return;
      const len = Number(/content-length:\s*(\d+)/i.exec(buf.subarray(0, hdrEnd).toString('ascii'))[1]);
      if (buf.length < hdrEnd + 4 + len) return;
      const msg = JSON.parse(buf.subarray(hdrEnd + 4, hdrEnd + 4 + len).toString('utf8'));
      buf = buf.subarray(hdrEnd + 4 + len);
      handle(c, msg);
    }
  });
  sock.on('close', () => log(`[${name}] socket closed`));
  return c;
}
function send(c, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  c.sock.write(`Content-Length: ${body.length}\r\n\r\n`);
  c.sock.write(body);
}
function request(c, command, args, timeout = 20_000) {
  const seq = c.seq++;
  return new Promise((res) => {
    const t = setTimeout(() => {
      c.pending.delete(seq);
      res({ success: false, message: 'TIMEOUT', timeout: true });
    }, timeout);
    c.pending.set(seq, (m) => {
      clearTimeout(t);
      res(m);
    });
    send(c, { seq, type: 'request', command, arguments: args });
  });
}
function handle(c, msg) {
  if (msg.type === 'response') {
    const p = c.pending.get(msg.request_seq);
    if (p) {
      c.pending.delete(msg.request_seq);
      p(msg);
    }
  } else if (msg.type === 'event') {
    c.events.push({ at: ms(), event: msg.event, body: msg.body });
    if (msg.event === 'output') {
      const cat = msg.body?.category ?? '(none)';
      outputCats.set(cat, (outputCats.get(cat) ?? 0) + 1);
      if (cat !== 'telemetry') log(`[${c.name}] output/${cat}:`, JSON.stringify(msg.body.output).slice(0, 80));
    } else {
      log(`[${c.name}] event ${msg.event}`, JSON.stringify(msg.body ?? {}).slice(0, 200));
    }
    if (msg.event === 'stopped') {
      const rs = stoppedResolvers;
      stoppedResolvers = [];
      for (const r of rs) r({ conn: c, body: msg.body });
    }
  } else if (msg.type === 'request') {
    log(`[${c.name}] REVERSE REQUEST ${msg.command}`, JSON.stringify(msg.arguments ?? {}).slice(0, 400));
    if (msg.command === 'startDebugging') {
      send(c, { seq: c.seq++, type: 'response', request_seq: msg.seq, success: true, command: msg.command });
      void startChild(msg.arguments);
    } else {
      send(c, { seq: c.seq++, type: 'response', request_seq: msg.seq, success: false, command: msg.command, message: 'not supported by spike' });
    }
  }
}
const waitStopped = (timeout = 10_000) =>
  new Promise((res) => {
    stoppedResolvers.push(res);
    setTimeout(() => res(null), timeout);
  });

async function handshake(c, { sendBps }) {
  const t = ms();
  const init = await request(c, 'initialize', {
    clientID: 'prontella-spike', adapterID: 'node', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path',
    supportsRunInTerminalRequest: process.env.SPIKE_CONSOLE === 'integratedTerminal', supportsStartDebuggingRequest: true,
  });
  log(`[${c.name}] initialize ${ms() - t}ms success=${init.success} initialized-event-seen=${c.events.some((e) => e.event === 'initialized')}`);
  if (c.name === 'root') {
    const caps = init.body ?? {};
    log('D2 capabilities:', JSON.stringify(Object.fromEntries(Object.entries(caps).filter(([k]) => /^supports|exceptionBreakpointFilters/.test(k)).map(([k, v]) => [k, k === 'exceptionBreakpointFilters' ? v.map((f) => f.filter) : v]))));
  }
  if (sendBps) {
    const bp = await request(c, 'setBreakpoints', { source: { path: program }, breakpoints: [{ line: bpLine }] });
    log(`[${c.name}] setBreakpoints(before launch) success=${bp.success}`, JSON.stringify(bp.body?.breakpoints ?? bp.message));
  }
  const cd = await request(c, 'configurationDone', {});
  log(`[${c.name}] configurationDone success=${cd.success} ${cd.message ?? ''}`);
}

let childConn = null;
async function startChild(args) {
  const c = connect('child');
  childConn = c;
  await handshake(c, { sendBps: !process.env.SPIKE_NO_CHILD_BP });
  const t = ms();
  const r = await request(c, args.request, args.configuration);
  log(`[child] ${args.request} response ${ms() - t}ms success=${r.success} ${r.message ?? ''}`);
}

// ---- root session -------------------------------------------------------------
const rootConn = connect('root');
await handshake(rootConn, { sendBps: true });
const launchArgs = {
  type: 'pwa-node', request: 'launch', name: 'spike', program, cwd: root, console: process.env.SPIKE_CONSOLE ?? 'internalConsole',
  ...(process.env.SPIKE_RUNTIME_ARGS ? { runtimeArgs: process.env.SPIKE_RUNTIME_ARGS.split(' ') } : {}),
};
const tLaunch = ms();
const stoppedP = waitStopped(15_000);
const launch = await request(rootConn, 'launch', launchArgs);
log(`[root] launch response ${ms() - tLaunch}ms success=${launch.success} ${launch.message ?? ''}`);

// ---- D3/D4/D5: 停止後 -----------------------------------------------------------
const first = await stoppedP;
if (!first) {
  log('NO stopped event within 15s');
} else {
  log(`D5 first stopped ${ms() - tLaunch}ms after launch, on conn=${first.conn.name}, reason=${first.body.reason} threadId=${first.body.threadId}`);
  const c = first.conn;
  const tid = first.body.threadId;
  const threads = await request(c, 'threads', {});
  log('threads:', JSON.stringify(threads.body));
  const st = await request(c, 'stackTrace', { threadId: tid, startFrame: 0, levels: 20 });
  for (const f of st.body?.stackFrames ?? []) log('  frame', f.id, f.name, JSON.stringify(f.source), f.line, f.column, f.presentationHint ?? '');
  const frame = st.body.stackFrames[0];
  let t = ms();
  const scopes = await request(c, 'scopes', { frameId: frame.id });
  log(`scopes ${ms() - t}ms:`, JSON.stringify(scopes.body?.scopes.map((s) => [s.name, s.variablesReference, s.expensive])));
  const local = scopes.body.scopes.find((s) => /local/i.test(s.name)) ?? scopes.body.scopes[0];
  t = ms();
  const vars = await request(c, 'variables', { variablesReference: local.variablesReference });
  log(`variables(${local.name}) ${ms() - t}ms count=${vars.body?.variables.length}`, JSON.stringify(vars.body?.variables.map((v) => [v.name, v.value.slice(0, 20), v.variablesReference])));
  const objVar = vars.body.variables.find((v) => v.name === 'obj');
  if (objVar) {
    t = ms();
    const objVars = await request(c, 'variables', { variablesReference: objVar.variablesReference });
    log(`variables(obj) ${ms() - t}ms count=${objVars.body?.variables.length}`);
    const arr = objVars.body.variables.find((v) => v.name === 'arr');
    t = ms();
    const arrVars = await request(c, 'variables', { variablesReference: arr.variablesReference });
    log(`variables(arr, 50) ${ms() - t}ms count=${arrVars.body?.variables.length}`);
  }
  t = ms();
  const ev = await request(c, 'evaluate', { expression: 'n + 1', frameId: frame.id, context: 'repl' });
  log(`evaluate repl ${ms() - t}ms:`, JSON.stringify(ev.body ?? ev.message));

  // ステップ計測
  const times = { next: [], stepIn: [], stepOut: [], continue: [] };
  async function step(cmd, n) {
    for (let i = 0; i < n; i++) {
      const p = waitStopped(5_000);
      const t = ms();
      const r = await request(c, cmd, { threadId: tid });
      const s = await p;
      times[cmd].push(ms() - t);
      if (!r.success || !s) {
        log(`${cmd} #${i} success=${r.success} stopped=${!!s} ${r.message ?? ''}`);
        return;
      }
    }
  }
  await step('next', 10);
  await step('stepIn', 3);
  await step('stepOut', 3);
  const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];
  for (const k of ['next', 'stepIn', 'stepOut']) log(`D5 ${k}: n=${times[k].length} p50=${pct(times[k], 0.5)} p95=${pct(times[k], 0.95)} all=${times[k].join(',')}`);

  // BP 検証 (launch 後)
  const bp2 = await request(c, 'setBreakpoints', { source: { path: program }, breakpoints: [{ line: bpLine }, { line: 3 }] });
  log('D4 setBreakpoints(after launch, incl. comment line 3):', JSON.stringify(bp2.body?.breakpoints));

  // continue → BP で再停止 (ループ 3 回)
  for (let i = 0; i < 2; i++) {
    const p = waitStopped(5_000);
    await request(c, 'continue', { threadId: tid });
    const s = await p;
    log(`continue #${i} → stopped=${!!s} reason=${s?.body.reason}`);
  }
  // D8 RSS
  // js-debug は `process` イベントを送らないので pid は REPL で取る
  const procEv = conns.flatMap((cc) => cc.events).find((e) => e.event === 'process');
  log('process event:', JSON.stringify(procEv?.body));
  const pidEv = await request(c, 'evaluate', { expression: 'process.pid', context: 'repl' });
  const debuggeePid = Number(pidEv.body?.result) || undefined;
  log('debuggee pid via evaluate:', debuggeePid, pidEv.message ?? '');
  for (const [label, pid] of [['adapter', adapter.pid], ['debuggee', debuggeePid]]) {
    if (!pid) continue;
    try {
      const ws = execFileSync('powershell', ['-NoProfile', '-c', `(Get-Process -Id ${pid}).WorkingSet64`], { encoding: 'utf8' }).trim();
      log(`D8 RSS ${label} pid=${pid}: ${Math.round(Number(ws) / 1048576)} MB`);
    } catch (e) {
      log(`D8 RSS ${label} pid=${pid}: 取得失敗`, e.message.split('\n')[0]);
    }
  }
  // continue して終わりまで走らせる (残りの BP ヒットを流す)
  await request(c, 'setBreakpoints', { source: { path: program }, breakpoints: [] });
  await request(c, 'continue', { threadId: tid });
  await new Promise((r) => setTimeout(r, 1500));

  // ---- D7: 後始末 ----
  const alive = (pid) => {
    try {
      execFileSync('powershell', ['-NoProfile', '-c', `Get-Process -Id ${pid} -ErrorAction Stop | Out-Null`], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  log('debuggee alive before teardown:', debuggeePid ? alive(debuggeePid) : 'unknown pid');
  const tTear = ms();
  if (process.env.SPIKE_KILL) {
    adapter.kill();
    log('D7 adapter.kill() sent');
  } else {
    // SPIKE_DISCONNECT=root: root だけに disconnect を送る (子は adapter が畳むか)。既定は child → root
    const targets = process.env.SPIKE_DISCONNECT === 'root' ? [rootConn] : [childConn, rootConn];
    for (const cc of targets.filter(Boolean)) {
      const r = await request(cc, 'disconnect', { terminateDebuggee: true }, 5_000);
      log(`[${cc.name}] disconnect success=${r.success} ${r.message ?? ''} ${r.timeout ? 'TIMEOUT' : ''}`);
    }
  }
  if (debuggeePid) {
    for (let i = 0; i < 50 && alive(debuggeePid); i++) await new Promise((r) => setTimeout(r, 100));
    log(`D7 debuggee ${alive(debuggeePid) ? 'STILL ALIVE' : 'gone'} after ${ms() - tTear}ms`);
  }
}

log('D8 output categories:', JSON.stringify([...outputCats]));
for (const c of conns) log(`[${c.name}] events:`, c.events.map((e) => e.event).join(' '));
for (const c of conns) c.sock.destroy();
adapter.kill();
await new Promise((r) => setTimeout(r, 500));
log('adapter exited:', adapter.exitCode, adapter.signalCode);
process.exit(0);
