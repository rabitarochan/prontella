// Phase 0 spike for the Roslyn language server (Microsoft.CodeAnalysis.LanguageServer).
// Measures initialize / project load / completion latency, positionEncoding, what
// --autoLoadProjects loads in a multi-solution root, server→client traffic, memory
// (LS + BuildHost children), and how the process reacts to exit / kill.
//
// Usage: node scripts/lsp-spike/s3-roslyn.mjs <root> <file.cs> [file2.cs ...]
//   SPIKE_CMD       path to Microsoft.CodeAnalysis.LanguageServer.exe (default: newest VS Code C# extension)
//   SPIKE_AUTOLOAD  1 (default) → pass --autoLoadProjects; 0 → don't
//   SPIKE_SOLUTION  path to a .sln → send solution/open after initialized
//   SPIKE_LOGDIR    --extensionLogDirectory (default: <tmp>/prontella-roslyn-spike, NOT pre-created)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2]);
const files = process.argv.slice(3);
if (!files.length) throw new Error('need at least one .cs file');

function defaultCmd() {
  const dir = path.join(os.homedir(), '.vscode', 'extensions');
  const cands = fs.readdirSync(dir).filter((n) => n.startsWith('ms-dotnettools.csharp-')).sort().reverse();
  for (const c of cands) {
    const exe = path.join(dir, c, '.roslyn', 'Microsoft.CodeAnalysis.LanguageServer.exe');
    if (fs.existsSync(exe)) return exe;
  }
  throw new Error('Roslyn LS not found under ' + dir);
}
const cmd = process.env.SPIKE_CMD ?? defaultCmd();
const logDir = process.env.SPIKE_LOGDIR ?? path.join(os.tmpdir(), 'prontella-roslyn-spike');
const autoload = (process.env.SPIKE_AUTOLOAD ?? '1') === '1';
const args = ['--stdio', '--logLevel', 'Information', '--extensionLogDirectory', logDir, '--clientProcessId', String(process.pid)];
if (autoload) args.push('--autoLoadProjects');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uri = (abs) => pathToFileURL(abs).href;
const t0 = performance.now();
const ms = () => Math.round(performance.now() - t0);

console.log('spawn:', cmd, args.join(' '));
console.log('logDir exists before spawn:', fs.existsSync(logDir));
const child = spawn(cmd, args, { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', (d) => (stderr += d));
child.on('exit', (code, sig) => console.log(`[exit] code=${code} sig=${sig} at ${ms()}ms`));

let buf = Buffer.alloc(0);
const pending = new Map();
const serverRequests = new Map(); // method -> count
const notifications = new Map(); // method -> count
let projectInitAt = null;
const progress = [];
let nextId = 1;
child.stdout.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const hdrEnd = buf.indexOf('\r\n\r\n');
    if (hdrEnd < 0) return;
    const m = /content-length:\s*(\d+)/i.exec(buf.subarray(0, hdrEnd).toString('ascii'));
    const len = Number(m[1]);
    if (buf.length < hdrEnd + 4 + len) return;
    const msg = JSON.parse(buf.subarray(hdrEnd + 4, hdrEnd + 4 + len).toString('utf8'));
    buf = buf.subarray(hdrEnd + 4 + len);
    if (msg.id !== undefined && msg.method === undefined) {
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    } else if (msg.id !== undefined && msg.method) {
      serverRequests.set(msg.method, (serverRequests.get(msg.method) ?? 0) + 1);
      if (msg.method === 'workspace/configuration') send({ jsonrpc: '2.0', id: msg.id, result: msg.params.items.map(() => null) });
      else if (msg.method === 'client/registerCapability' || msg.method === 'window/workDoneProgress/create') send({ jsonrpc: '2.0', id: msg.id, result: null });
      else {
        console.log(`   [server request] ${msg.method} params=${JSON.stringify(msg.params).slice(0, 160)} → -32601`);
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
      }
    } else {
      notifications.set(msg.method, (notifications.get(msg.method) ?? 0) + 1);
      if (msg.method === 'workspace/projectInitializationComplete') projectInitAt = ms();
      if (msg.method === '$/progress') progress.push(JSON.stringify(msg.params).slice(0, 120));
      if (msg.method === 'window/logMessage' && msg.params.type <= 2) console.log(`   [log ${msg.params.type}] ${String(msg.params.message).slice(0, 200)}`);
      if (msg.method === 'window/showMessage') console.log(`   [showMessage] ${JSON.stringify(msg.params).slice(0, 200)}`);
    }
  }
});
function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  child.stdin.write(body);
}
function request(method, params, timeoutMs = 60_000) {
  const id = nextId++;
  return new Promise((res) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      res({ error: { code: -1, message: `timeout ${timeoutMs}ms` } });
    }, timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      res(msg);
    });
    send({ jsonrpc: '2.0', id, method, params });
  });
}
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });

function positions(text, n) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /\b[a-zA-Z_]\w*\.(?=[a-zA-Z_])/.exec(lines[i]);
    if (m && !/^\s*(using|namespace)\b/.test(lines[i])) out.push({ line: i, character: m.index + m[0].length, src: lines[i].trim().slice(0, 60) });
  }
  const step = Math.max(1, Math.floor(out.length / n));
  return out.filter((_, i) => i % step === 0).slice(0, n);
}
function pct(a, p) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}
function memTree(pid) {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='dotnet.exe' OR Name='Microsoft.CodeAnalysis.LanguageServer.exe'" | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.WorkingSetSize) $($_.Name)" }`;
  const rows = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' })
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const [p, pp, ws, name] = l.split(' ');
      return { pid: Number(p), ppid: Number(pp), mb: Math.round(Number(ws) / 1048576), name };
    });
  const set = new Set([pid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) if (set.has(r.ppid) && !set.has(r.pid)) (set.add(r.pid), (grew = true));
  }
  return rows.filter((r) => set.has(r.pid));
}

async function main() {
  const init = await request('initialize', {
    processId: process.pid,
    rootUri: uri(root),
    workspaceFolders: [{ uri: uri(root), name: path.basename(root) }],
    capabilities: {
      general: { positionEncodings: ['utf-16'] },
      textDocument: {
        synchronization: { didSave: true },
        completion: { completionItem: { snippetSupport: true, insertReplaceSupport: true, documentationFormat: ['markdown', 'plaintext'], resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] } } },
        hover: { contentFormat: ['markdown', 'plaintext'] },
        definition: { linkSupport: true },
        publishDiagnostics: {},
      },
      workspace: { configuration: false, workspaceFolders: true },
    },
  });
  console.log(`R1 initialize: ${ms()}ms`, init.error ? 'ERROR ' + JSON.stringify(init.error) : '');
  if (init.error) process.exit(1);
  const caps = init.result.capabilities;
  console.log('   positionEncoding:', caps.positionEncoding, '| sync:', JSON.stringify(caps.textDocumentSync), '| completion:', JSON.stringify(caps.completionProvider)?.slice(0, 200));
  console.log('   diagnosticProvider:', JSON.stringify(caps.diagnosticProvider)?.slice(0, 120), '| serverInfo:', JSON.stringify(init.result.serverInfo));
  notify('initialized', {});
  if (process.env.SPIKE_SOLUTION) {
    console.log('   solution/open', process.env.SPIKE_SOLUTION);
    notify('solution/open', { solution: uri(path.resolve(process.env.SPIKE_SOLUTION)) });
  }

  // open all files first, then wait for project initialization
  const texts = new Map();
  for (const f of files) {
    const abs = path.resolve(root, f);
    const text = fs.readFileSync(abs, 'utf8');
    texts.set(f, text);
    notify('textDocument/didOpen', { textDocument: { uri: uri(abs), languageId: 'csharp', version: 1, text } });
  }
  const waitUntil = performance.now() + 180_000;
  while (projectInitAt === null && performance.now() < waitUntil) await sleep(250);
  console.log(`R2 projectInitializationComplete: ${projectInitAt === null ? 'NOT RECEIVED in 180s' : projectInitAt + 'ms'}`);
  console.log('   memory after load:', JSON.stringify(memTree(child.pid)));
  console.log('   logDir exists after load:', fs.existsSync(logDir));

  for (const f of files) {
    const abs = path.resolve(root, f);
    const u = uri(abs);
    const text = texts.get(f);
    console.log(`\n== ${f}`);
    const diag = await request('textDocument/diagnostic', { textDocument: { uri: u } }, 120_000);
    const items = diag.result?.items ?? [];
    console.log(`   diagnostics: ${diag.error ? 'ERROR ' + diag.error.message : items.length} ${items.slice(0, 3).map((d) => `[${d.code}] ${String(d.message).slice(0, 60)}`).join(' | ')}`);
    const pos = positions(text, 8);
    const times = [];
    for (const [i, p] of pos.entries()) {
      const t = performance.now();
      const r = await request('textDocument/completion', { textDocument: { uri: u }, position: { line: p.line, character: p.character }, context: { triggerKind: 2, triggerCharacter: '.' } }, 120_000);
      const dt = performance.now() - t;
      times.push(dt);
      const list = r.result?.items ?? r.result ?? [];
      const labels = list.slice(0, 4).map((it) => (typeof it.label === 'string' ? it.label : it.label?.label)).join(', ');
      console.log(`   L${p.line + 1} ${Math.round(dt)}ms items=${r.error ? 'ERR ' + r.error.message : list.length} incomplete=${r.result?.isIncomplete} ${i === 0 ? 'first' : ''} :: ${p.src} → ${labels}`);
      if (i === 0 && list[0]) {
        const rr = await request('completionItem/resolve', list[0], 30_000);
        console.log(`   resolve[0]: ${rr.error ? 'ERR' : 'ok'} detail=${String(rr.result?.detail ?? '').slice(0, 60)} textEdit=${!!list[0].textEdit} data=${list[0].data !== undefined}`);
      }
    }
    if (times.length > 1) console.log(`   warm completion p50=${Math.round(pct(times.slice(1), 0.5))}ms p95=${Math.round(pct(times.slice(1), 0.95))}ms`);
    if (pos[0]) {
      const before = { line: pos[0].line, character: pos[0].character - 2 };
      const h = await request('textDocument/hover', { textDocument: { uri: u }, position: before }, 30_000);
      console.log(`   hover: ${h.error ? 'ERR' : JSON.stringify(h.result?.contents).slice(0, 160)}`);
      const d = await request('textDocument/definition', { textDocument: { uri: u }, position: before }, 30_000);
      console.log(`   definition: ${JSON.stringify(d.result).slice(0, 220)}`);
    }
    // R7: definition of Console (metadata) — find "Console." anywhere
    const idx = text.indexOf('Console.');
    if (idx >= 0) {
      const line = text.slice(0, idx).split('\n').length - 1;
      const character = idx - text.lastIndexOf('\n', idx - 1) - 1 + 2;
      const d = await request('textDocument/definition', { textDocument: { uri: u }, position: { line, character } }, 60_000);
      console.log(`   R7 definition(Console): ${JSON.stringify(d.result).slice(0, 220)}`);
    }
  }

  console.log('\nR6 server→client requests:', JSON.stringify([...serverRequests]));
  console.log('   notifications:', JSON.stringify([...notifications]));
  console.log('   progress samples:', progress.slice(0, 3));
  console.log('   memory before shutdown:', JSON.stringify(memTree(child.pid)));

  // R5: shutdown / exit / kill
  const sd = await request('shutdown', null, 10_000);
  console.log(`R5 shutdown: ${sd.error ? sd.error.message : 'ok'} at ${ms()}ms`);
  notify('exit', null);
  await sleep(3000);
  console.log('   alive 3s after exit:', child.exitCode === null, JSON.stringify(memTree(child.pid)));
  if (child.exitCode === null) {
    child.kill();
    await sleep(2000);
    console.log('   after kill():', JSON.stringify(memTree(child.pid)));
  }
  console.log('stderr tail:', stderr.slice(-400));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
