// Phase 0 spike (C#): netcoredbg を `--interpreter=vscode` (stdio DAP) で叩き、起動・ハンドシェイク順序・
// 逆要求・BP 検証・ステップ時間・後始末・env 依存 (DOTNET_ROOT / PATH の dotnet) を測る。
// Usage: SPIKE_DBG=<netcoredbg.exe> node scripts/dap-spike/d3-netcoredbg.mjs <program.dll> [options]
//   SPIKE_ENV=min                     env を最小 (PATH に dotnet 無し、DOTNET_ROOT 無し) にして起動できるか
//   SPIKE_ENV=root                    最小 + DOTNET_ROOT だけ
//   SPIKE_CONSOLE=integratedTerminal  runInTerminal が来るか
//   SPIKE_KILL=1                      disconnect の代わりに adapter を kill して debuggee が孤児になるか
//   SPIKE_SERVER=1                    --server (TCP) モードでも動くか (listen 行の形)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const dbg = process.env.SPIKE_DBG;
if (!dbg) throw new Error('SPIKE_DBG を指定してください');
const program = path.resolve(process.argv[2]);
const root = path.dirname(program);
const srcFile = process.env.SPIKE_SRC ?? path.join(root, '..', '..', '..', 'Program.cs');
// SPIKE_LINE=<n> で BP 行を差し替える (netcoredbg が行を動かすかの確認用)
// 先頭のヘッダーコメントにも `// BP` が書いてあるので 2 行目以降から探す (初回の測定はこれで line 1 を置いていた)
const bpLine = Number(process.env.SPIKE_LINE) || fs.readFileSync(srcFile, 'utf8').split('\n').findIndex((l, i) => i > 0 && l.includes('// BP')) + 1;
const t0 = performance.now();
const ms = () => Math.round(performance.now() - t0);
const log = (...a) => console.log(`[${String(ms()).padStart(6)}ms]`, ...a);
log('BP line', bpLine);

// ---- env の組み立て ----
let env = { ...process.env };
const dotnetRoot = process.env.DOTNET_ROOT ?? path.dirname(execFileSync('where', ['dotnet'], { encoding: 'utf8' }).split(/\r?\n/)[0]);
//   SPIKE_ENV=path                    最小 + PATH に dotnet のディレクトリーだけ
if (['min', 'root', 'path'].includes(process.env.SPIKE_ENV ?? '')) {
  env = { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, USERPROFILE: process.env.USERPROFILE, PATH: 'C:\\Windows\\System32;C:\\Windows' };
  if (process.env.SPIKE_ENV === 'root') env.DOTNET_ROOT = dotnetRoot;
  if (process.env.SPIKE_ENV === 'path') env.PATH = `${dotnetRoot};${env.PATH}`;
}
log('env mode', process.env.SPIKE_ENV ?? 'inherit', 'DOTNET_ROOT=', env.DOTNET_ROOT ?? '(none)', 'dotnet on PATH:', /dotnet/i.test(env.PATH ?? ''));

// ---- 起動 (stdio or --server) ----
const args = process.env.SPIKE_SERVER ? ['--interpreter=vscode', '--server=0'] : ['--interpreter=vscode'];
const adapter = spawn(dbg, args, { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env });
adapter.stderr.on('data', (d) => process.stderr.write('[adapter stderr] ' + d));
adapter.on('exit', (c, s) => log('adapter exit', c, s));

let write;
let readable;
if (process.env.SPIKE_SERVER) {
  let out = '';
  const port = await new Promise((res, rej) => {
    adapter.stdout.on('data', (d) => {
      out += d;
      log('adapter stdout:', JSON.stringify(String(d)));
      const m = /(\d{2,5})/.exec(out);
      if (m) res(Number(m[1]));
    });
    setTimeout(() => rej(new Error('no listen line: ' + JSON.stringify(out))), 5_000);
  });
  const sock = net.connect({ host: '127.0.0.1', port });
  await new Promise((r) => sock.on('connect', r));
  write = (b) => sock.write(b);
  readable = sock;
} else {
  write = (b) => adapter.stdin.write(b);
  readable = adapter.stdout;
}

const events = [];
const pending = new Map();
let seq = 1;
let stoppedResolvers = [];
let buf = Buffer.alloc(0);
readable.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const hdrEnd = buf.indexOf('\r\n\r\n');
    if (hdrEnd < 0) return;
    const len = Number(/content-length:\s*(\d+)/i.exec(buf.subarray(0, hdrEnd).toString('ascii'))[1]);
    if (buf.length < hdrEnd + 4 + len) return;
    const msg = JSON.parse(buf.subarray(hdrEnd + 4, hdrEnd + 4 + len).toString('utf8'));
    buf = buf.subarray(hdrEnd + 4 + len);
    handle(msg);
  }
});
function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  write(`Content-Length: ${body.length}\r\n\r\n`);
  write(body);
}
function request(command, args, timeout = 20_000) {
  const s = seq++;
  return new Promise((res) => {
    const t = setTimeout(() => (pending.delete(s), res({ success: false, message: 'TIMEOUT', timeout: true })), timeout);
    pending.set(s, (m) => (clearTimeout(t), res(m)));
    send({ seq: s, type: 'request', command, arguments: args });
  });
}
function handle(msg) {
  if (msg.type === 'response') {
    pending.get(msg.request_seq)?.(msg);
    pending.delete(msg.request_seq);
  } else if (msg.type === 'event') {
    events.push({ at: ms(), event: msg.event, body: msg.body });
    if (msg.event === 'output') log(`output/${msg.body?.category}:`, JSON.stringify(msg.body?.output).slice(0, 100));
    else log(`event ${msg.event}`, JSON.stringify(msg.body ?? {}).slice(0, 220));
    if (msg.event === 'stopped') {
      const rs = stoppedResolvers;
      stoppedResolvers = [];
      for (const r of rs) r(msg.body);
    }
  } else if (msg.type === 'request') {
    log(`REVERSE REQUEST ${msg.command}`, JSON.stringify(msg.arguments ?? {}).slice(0, 400));
    send({ seq: seq++, type: 'response', request_seq: msg.seq, success: false, command: msg.command, message: 'not supported by spike' });
  }
}
const waitStopped = (timeout = 10_000) => new Promise((res) => (stoppedResolvers.push(res), setTimeout(() => res(null), timeout)));

// ---- D2: ハンドシェイク ----
let t = ms();
const init = await request('initialize', { clientID: 'prontella-spike', adapterID: 'coreclr', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path', supportsRunInTerminalRequest: process.env.SPIKE_CONSOLE === 'integratedTerminal', supportsVariableType: true });
log(`initialize ${ms() - t}ms success=${init.success} initialized-seen=${events.some((e) => e.event === 'initialized')}`);
log('D2 capabilities:', JSON.stringify(Object.fromEntries(Object.entries(init.body ?? {}).filter(([k, v]) => v === true || k === 'exceptionBreakpointFilters').map(([k, v]) => [k, Array.isArray(v) ? v.map((f) => f.filter) : v]))));
//   SPIKE_CWD=<dir>                   launch の cwd を差し替える (netcoredbg が cwd を尊重するかの確認)
//   SPIKE_LAUNCH_EXTRA='{"env":{...},"args":[...]}'  launch 引数に混ぜる (env / args の通過確認)
const launchArgs = { type: 'coreclr', request: 'launch', name: 'spike', program, cwd: process.env.SPIKE_CWD ?? root, console: process.env.SPIKE_CONSOLE ?? 'internalConsole', stopAtEntry: false, ...JSON.parse(process.env.SPIKE_LAUNCH_EXTRA ?? '{}') };
// netcoredbg は launch → initialized → setBreakpoints → configurationDone の順を要求するか、先に BP を置けるかを両方試す
const bp0 = await request('setBreakpoints', { source: { path: srcFile }, breakpoints: [{ line: bpLine }] });
log(`setBreakpoints(before launch) success=${bp0.success}`, JSON.stringify(bp0.body?.breakpoints ?? bp0.message));
t = ms();
const stoppedP = waitStopped(20_000);
const launch = await request('launch', launchArgs);
log(`launch response ${ms() - t}ms success=${launch.success} ${launch.message ?? ''}`);
const bp1 = await request('setBreakpoints', { source: { path: srcFile }, breakpoints: [{ line: bpLine }] });
log(`setBreakpoints(after launch) success=${bp1.success}`, JSON.stringify(bp1.body?.breakpoints ?? bp1.message));
const cd = await request('configurationDone', {});
log(`configurationDone success=${cd.success} ${cd.message ?? ''}`);

const first = await stoppedP;
if (!first) {
  log('NO stopped event');
} else {
  log(`D5 first stopped ${ms() - t}ms after launch reason=${first.reason} threadId=${first.threadId} allThreadsStopped=${first.allThreadsStopped}`);
  const tid = first.threadId;
  const threads = await request('threads', {});
  log('threads:', JSON.stringify(threads.body));
  const st = await request('stackTrace', { threadId: tid, startFrame: 0, levels: 20 });
  for (const f of st.body?.stackFrames ?? []) log('  frame', f.id, f.name, JSON.stringify(f.source), f.line, f.column, f.presentationHint ?? '');
  const frame = st.body.stackFrames[0];
  t = ms();
  const scopes = await request('scopes', { frameId: frame.id });
  log(`scopes ${ms() - t}ms:`, JSON.stringify(scopes.body?.scopes.map((s) => [s.name, s.variablesReference, s.expensive])));
  t = ms();
  const vars = await request('variables', { variablesReference: scopes.body.scopes[0].variablesReference });
  log(`variables(${scopes.body.scopes[0].name}) ${ms() - t}ms count=${vars.body?.variables.length}`, JSON.stringify(vars.body?.variables.map((v) => [v.name, v.value.slice(0, 30), v.type, v.variablesReference])));
  const objVar = vars.body?.variables.find((v) => v.name === 'obj');
  if (objVar?.variablesReference) {
    t = ms();
    const ov = await request('variables', { variablesReference: objVar.variablesReference });
    log(`variables(obj) ${ms() - t}ms`, JSON.stringify(ov.body?.variables.map((v) => [v.name, v.value.slice(0, 20), v.variablesReference])));
    const arr = ov.body?.variables.find((v) => v.name === 'Arr');
    if (arr?.variablesReference) {
      t = ms();
      const av = await request('variables', { variablesReference: arr.variablesReference });
      log(`variables(Arr, 50) ${ms() - t}ms count=${av.body?.variables.length}`);
    }
  }
  t = ms();
  const ev = await request('evaluate', { expression: 'n + 1', frameId: frame.id, context: 'repl' });
  log(`evaluate repl ${ms() - t}ms:`, JSON.stringify(ev.body ?? ev.message));
  const ev2 = await request('evaluate', { expression: 'zzz', frameId: frame.id, context: 'repl' });
  log(`evaluate error shape: success=${ev2.success}`, JSON.stringify(ev2.message ?? ev2.body).slice(0, 200));

  const times = { next: [], stepIn: [], stepOut: [] };
  async function step(cmd, n) {
    for (let i = 0; i < n; i++) {
      const p = waitStopped(5_000);
      const t = ms();
      const r = await request(cmd, { threadId: tid });
      const s = await p;
      times[cmd].push(ms() - t);
      if (!r.success || !s) return log(`${cmd} #${i} success=${r.success} stopped=${!!s} ${r.message ?? ''}`);
    }
  }
  await step('next', 10);
  await step('stepIn', 3);
  await step('stepOut', 3);
  const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];
  for (const k of Object.keys(times)) log(`D5 ${k}: n=${times[k].length} p50=${pct(times[k], 0.5)} p95=${pct(times[k], 0.95)} all=${times[k].join(',')}`);

  const bp2 = await request('setBreakpoints', { source: { path: srcFile }, breakpoints: [{ line: bpLine }, { line: 2 }] });
  log('D4 setBreakpoints(incl. using line 2):', JSON.stringify(bp2.body?.breakpoints));
  for (let i = 0; i < 2; i++) {
    const p = waitStopped(5_000);
    await request('continue', { threadId: tid });
    const s = await p;
    log(`continue #${i} → stopped=${!!s} reason=${s?.reason}`);
  }
  const pidEv = await request('evaluate', { expression: 'System.Environment.ProcessId', context: 'repl' });
  const debuggeePid = Number(pidEv.body?.result) || undefined;
  log('debuggee pid via evaluate:', debuggeePid, pidEv.message ?? '');
  const procEv = events.find((e) => e.event === 'process');
  log('process event:', JSON.stringify(procEv?.body));
  for (const [label, pid] of [['adapter', adapter.pid], ['debuggee', debuggeePid ?? procEv?.body?.systemProcessId]]) {
    if (!pid) continue;
    try {
      const ws = execFileSync('powershell', ['-NoProfile', '-c', `(Get-Process -Id ${pid}).WorkingSet64`], { encoding: 'utf8' }).trim();
      log(`D8 RSS ${label} pid=${pid}: ${Math.round(Number(ws) / 1048576)} MB`);
    } catch {
      log(`D8 RSS ${label} pid=${pid}: 取得失敗`);
    }
  }
  await request('setBreakpoints', { source: { path: srcFile }, breakpoints: [] });
  await request('continue', { threadId: tid });
  await new Promise((r) => setTimeout(r, 1500));

  const alive = (pid) => {
    try {
      execFileSync('powershell', ['-NoProfile', '-c', `Get-Process -Id ${pid} -ErrorAction Stop | Out-Null`], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  const dp = debuggeePid ?? procEv?.body?.systemProcessId;
  log('debuggee alive before teardown:', dp ? alive(dp) : 'unknown');
  const tTear = ms();
  if (process.env.SPIKE_KILL) {
    adapter.kill();
    log('D7 adapter.kill() sent');
  } else {
    const r = await request('disconnect', { terminateDebuggee: true }, 5_000);
    log(`disconnect success=${r.success} ${r.message ?? ''} ${r.timeout ? 'TIMEOUT' : ''}`);
  }
  if (dp) {
    for (let i = 0; i < 50 && alive(dp); i++) await new Promise((r) => setTimeout(r, 100));
    log(`D7 debuggee ${alive(dp) ? 'STILL ALIVE' : 'gone'} after ${ms() - tTear}ms`);
  }
}
log('events:', events.map((e) => e.event).join(' '));
log('output categories:', JSON.stringify([...new Set(events.filter((e) => e.event === 'output').map((e) => e.body?.category))]));
adapter.kill();
await new Promise((r) => setTimeout(r, 500));
log('adapter exited:', adapter.exitCode, adapter.signalCode);
process.exit(0);
