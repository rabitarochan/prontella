// Phase 3 spike: (W) workspace/didChangeWatchedFiles — what the server registers, whether it sees files
// created / changed on disk without notification, and whether the notification fixes it;
// (S) workspace/symbol — response shape and timing. For tsgo and Roslyn.
//
// Usage: node scripts/lsp-spike/s5-watch-symbol.mjs <root> <openFile> <symbolQuery>
//   SPIKE_CMD / SPIKE_ARGS   launch (default: the root's tsgo)
//   SPIKE_SOLUTION           .sln to solution/open (Roslyn)
//   SPIKE_NEWFILE            path (relative to root) of a file the spike CREATES then DELETES
//                            (TS default: src/__spike_new.ts, C#: <dir of openFile>/__SpikeNew.cs)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2]);
const file = process.argv[3];
const query = process.argv[4] ?? 'Config';
const abs = path.resolve(root, file);
const languageId = path.extname(abs).toLowerCase() === '.cs' ? 'csharp' : 'typescript';
const cs = languageId === 'csharp';
const newRel = process.env.SPIKE_NEWFILE ?? (cs ? path.posix.join(path.dirname(file).split(path.sep).join('/'), '__SpikeNew.cs') : 'src/__spike_new.ts');
const newAbs = path.resolve(root, newRel);
const tsgo = path.join(root, 'node_modules', '@typescript', `typescript-${process.platform}-${process.arch}`, 'lib', process.platform === 'win32' ? 'tsc.exe' : 'tsc');
const cmd = process.env.SPIKE_CMD ?? tsgo;
const args = process.env.SPIKE_ARGS
  ? process.env.SPIKE_ARGS.split(' ')
  : cs
    ? ['--stdio', '--logLevel', 'Information', '--extensionLogDirectory', path.join(os.tmpdir(), 'prontella-roslyn-spike'), '--clientProcessId', String(process.pid)]
    : ['--lsp', '--stdio'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uri = (p) => pathToFileURL(p).href;
const t0 = performance.now();
const ms = () => Math.round(performance.now() - t0);
const short = (v, n = 300) => JSON.stringify(v)?.slice(0, n);

const child = spawn(cmd, args, { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', () => {});
child.on('exit', (code) => console.log(`[exit] code=${code} at ${ms()}ms`));
let buf = Buffer.alloc(0);
const pending = new Map();
let nextId = 1;
let projectInitAt = null;
const registrations = [];
child.stdout.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const hdrEnd = buf.indexOf('\r\n\r\n');
    if (hdrEnd < 0) return;
    const len = Number(/content-length:\s*(\d+)/i.exec(buf.subarray(0, hdrEnd).toString('ascii'))[1]);
    if (buf.length < hdrEnd + 4 + len) return;
    const msg = JSON.parse(buf.subarray(hdrEnd + 4, hdrEnd + 4 + len).toString('utf8'));
    buf = buf.subarray(hdrEnd + 4 + len);
    if (msg.id !== undefined && msg.method === undefined) {
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    } else if (msg.id !== undefined && msg.method) {
      if (msg.method === 'client/registerCapability') registrations.push(...(msg.params.registrations ?? []));
      if (msg.method === 'workspace/configuration') send({ jsonrpc: '2.0', id: msg.id, result: msg.params.items.map(() => null) });
      else send({ jsonrpc: '2.0', id: msg.id, result: null });
    } else if (msg.method === 'workspace/projectInitializationComplete') projectInitAt = ms();
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
    pending.set(id, (m) => {
      clearTimeout(timer);
      res(m);
    });
    send({ jsonrpc: '2.0', id, method, params });
  });
}
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });

// completion at the end of a line appended to the open doc, filtered by prefix
async function completionsFor(u, text, version, prefix) {
  if (cs) {
    // Roslyn の completion は 1000 件で打ち切られ prefix で絞れないので workspace/symbol で見る (反映待ち 4 秒)
    await sleep(4000);
    const q = prefix.replace(/^_+/, '');
    const t = performance.now();
    const r = await request('workspace/symbol', { query: q }, 60_000);
    const names = (r.result ?? []).map((x) => x.name);
    return { dt: Math.round(performance.now() - t), hits: names.filter((n) => n.includes(q)), total: names.length, sample: names.slice(0, 3) };
  }
  const lines = text.split('\n');
  const last = lines.length - 1;
  const lastLen = lines[last].length;
  const insert = (cs ? '\nclass __SpikeUse { void M() { ' : '\n') + prefix;
  notify('textDocument/didChange', { textDocument: { uri: u, version }, contentChanges: [{ range: { start: { line: last, character: lastLen }, end: { line: last, character: lastLen } }, text: insert }] });
  const t = performance.now();
  const r = await request('textDocument/completion', { textDocument: { uri: u }, position: { line: last + 1, character: insert.length - 1 }, context: { triggerKind: 1 } }, 30_000);
  const items = (r.result?.items ?? r.result ?? []).map((i) => (typeof i.label === 'string' ? i.label : i.label?.label));
  // revert
  notify('textDocument/didChange', { textDocument: { uri: u, version: version + 1 }, contentChanges: [{ range: { start: { line: last, character: lastLen }, end: { line: last + 1, character: insert.length - 1 } }, text: '' }] });
  return { dt: Math.round(performance.now() - t), hits: items.filter((l) => l && l.startsWith(prefix)), total: items.length };
}

async function symbols(q) {
  const t = performance.now();
  const r = await request('workspace/symbol', { query: q }, 60_000);
  const list = r.result ?? [];
  console.log(`S workspace/symbol("${q}"): ${Math.round(performance.now() - t)}ms →`, r.error ? 'ERROR ' + short(r.error) : `${list.length} results`);
  for (const s of list.slice(0, 4)) console.log('   ', short({ name: s.name, kind: s.kind, containerName: s.containerName, location: s.location, hasRange: !!s.location?.range, data: s.data !== undefined, tags: s.tags }, 260));
  return list;
}

async function main() {
  const init = await request('initialize', {
    processId: process.pid,
    rootUri: uri(root),
    workspaceFolders: [{ uri: uri(root), name: path.basename(root) }],
    capabilities: {
      general: { positionEncodings: ['utf-16'] },
      textDocument: { synchronization: { didSave: true }, completion: { completionItem: { snippetSupport: true } }, definition: { linkSupport: true }, diagnostic: {} },
      workspace: { configuration: false, workspaceFolders: true, didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true }, symbol: { symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) }, resolveSupport: { properties: ['location.range'] } } },
    },
  });
  console.log(`initialize ${ms()}ms workspaceSymbolProvider=${short(init.result.capabilities.workspaceSymbolProvider)}`);
  notify('initialized', {});
  if (process.env.SPIKE_SOLUTION) notify('solution/open', { solution: uri(path.resolve(process.env.SPIKE_SOLUTION)) });
  const text = fs.readFileSync(abs, 'utf8');
  const u = uri(abs);
  notify('textDocument/didOpen', { textDocument: { uri: u, languageId, version: 1, text } });
  if (process.env.SPIKE_SOLUTION) {
    const until = performance.now() + 180_000;
    while (projectInitAt === null && performance.now() < until) await sleep(250);
    console.log(`projectInitializationComplete: ${projectInitAt ?? 'NOT RECEIVED'}ms`);
  }
  await request('textDocument/diagnostic', { textDocument: { uri: u } }, 120_000); // warm (Roslyn)
  await sleep(500);
  console.log('W registrations:', JSON.stringify(registrations, null, 0));

  // ---- W1: create a new file on disk (not open) → does completion see its export without notification?
  const sym = cs ? '__SpikeNewClass' : '__spikeNewFn';
  const newText = cs ? `namespace __Spike;\npublic class ${sym} { public static int V = 1; }\n` : `export function ${sym}(): number { return 1; }\n`;
  fs.writeFileSync(newAbs, newText);
  const prefix = sym.slice(0, 8);
  let version = 2;
  await sleep(1500);
  let c = await completionsFor(u, text, version, prefix);
  version += 2;
  console.log(`W1 after fs.writeFile (no notification, 1.5s): hits=${short(c.hits)} total=${c.total} ${c.dt}ms`);
  if (c.hits.length === 0) {
    await sleep(3000);
    c = await completionsFor(u, text, version, prefix);
    version += 2;
    console.log(`W1b after 4.5s total: hits=${short(c.hits)} total=${c.total}`);
  }
  // ---- W2: send didChangeWatchedFiles Created
  notify('workspace/didChangeWatchedFiles', { changes: [{ uri: uri(newAbs), type: 1 }] });
  await sleep(1500);
  c = await completionsFor(u, text, version, prefix);
  version += 2;
  console.log(`W2 after didChangeWatchedFiles(Created): hits=${short(c.hits)} total=${c.total} ${c.dt}ms`);

  // ---- W3: change the new file on disk (rename the symbol) → without / with notification
  const sym2 = sym + 'B';
  fs.writeFileSync(newAbs, newText.replaceAll(sym, sym2));
  await sleep(1500);
  c = await completionsFor(u, text, version, sym2.slice(0, 8));
  version += 2;
  const seesOld = c.hits.includes(sym) || c.hits.includes(sym2) ? c.hits : [];
  console.log(`W3 after on-disk edit (no notification): hits=${short(c.hits)} (old=${c.hits.includes(sym)} new=${c.hits.includes(sym2)})`);
  notify('workspace/didChangeWatchedFiles', { changes: [{ uri: uri(newAbs), type: 2 }] });
  await sleep(1500);
  c = await completionsFor(u, text, version, sym2.slice(0, 8));
  version += 2;
  console.log(`W4 after didChangeWatchedFiles(Changed): hits=${short(c.hits)} (old=${c.hits.includes(sym)} new=${c.hits.includes(sym2)})`);
  if (!c.hits.includes(sym2)) {
    notify('workspace/didChangeWatchedFiles', { changes: [{ uri: uri(newAbs), type: 3 }, { uri: uri(newAbs), type: 1 }] });
    await sleep(1500);
    c = await completionsFor(u, text, version, sym2.slice(0, 8));
    version += 2;
    console.log(`W4b after Deleted+Created: hits=${short(c.hits)} (old=${c.hits.includes(sym)} new=${c.hits.includes(sym2)})`);
  }
  void seesOld;

  // ---- W5: delete the file → without / with notification
  fs.rmSync(newAbs);
  await sleep(1500);
  c = await completionsFor(u, text, version, sym2.slice(0, 8));
  version += 2;
  console.log(`W5 after fs.rm (no notification): hits=${short(c.hits)}`);
  notify('workspace/didChangeWatchedFiles', { changes: [{ uri: uri(newAbs), type: 3 }] });
  await sleep(1500);
  c = await completionsFor(u, text, version, sym2.slice(0, 8));
  version += 2;
  console.log(`W6 after didChangeWatchedFiles(Deleted): hits=${short(c.hits)}`);

  // ---- S: workspace/symbol
  await symbols(query);
  await symbols('');
  const list = await symbols(query.slice(0, 3).toLowerCase());
  const first = list[0];
  if (first && first.location && !first.location.range) {
    const r = await request('workspaceSymbol/resolve', first, 30_000);
    console.log('   resolve →', r.error ? 'ERROR ' + short(r.error) : short(r.result, 200));
  }

  await request('shutdown', undefined, 5_000);
  notify('exit', undefined);
  await sleep(1500);
  if (child.exitCode === null) child.kill();
}
main().catch((e) => {
  console.error(e);
  try {
    fs.rmSync(newAbs, { force: true });
  } catch {}
  child.kill();
  process.exit(1);
});
