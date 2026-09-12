// Phase 0 spike S2/S3/S4/S5/S6: spawn typescript-language-server via process.execPath,
// measure initialize / first completion / warm completion p50/p95, positionEncoding,
// .tsx languageId diagnostics diff, and resident memory of the LS + tsserver tree.
// Usage: node scripts/lsp-spike/s2.mjs [root] [file] [tsxFile]
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2] ?? '.');
const file = process.argv[3] ?? 'server/index.ts';
const tsxFile = process.argv[4] ?? 'client/src/components/FilesTab.tsx';
const cli = path.join(root, 'node_modules/typescript-language-server/lib/cli.mjs');
// SPIKE_CMD / SPIKE_ARGS override the launch (e.g. TS 7's `tsc.exe --lsp --stdio`)
const cmd = process.env.SPIKE_CMD ?? process.execPath;
const args = process.env.SPIKE_ARGS ? process.env.SPIKE_ARGS.split(' ') : [cli, '--stdio'];

function start() {
  const t0 = performance.now();
  const child = spawn(cmd, args, { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', (d) => process.stderr.write('[stderr] ' + d));
  let buf = Buffer.alloc(0);
  const pending = new Map();
  const notif = [];
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
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      } else if (msg.id !== undefined && msg.method) {
        // server→client request: answer so it doesn't hang
        const result = msg.method === 'workspace/configuration' ? msg.params.items.map(() => null) : null;
        send({ jsonrpc: '2.0', id: msg.id, result });
      } else notif.push(msg);
    }
  });
  function send(obj) {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    child.stdin.write(body);
  }
  function request(method, params) {
    const id = nextId++;
    return new Promise((res) => {
      pending.set(id, res);
      send({ jsonrpc: '2.0', id, method, params });
    });
  }
  function notify(method, params) {
    send({ jsonrpc: '2.0', method, params });
  }
  return { child, request, notify, notif, t0 };
}

function pct(a, p) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}
function uri(rel) {
  return pathToFileURL(path.join(root, rel)).href;
}

// completion positions: right after `.` in `ident.ident` member accesses, spread across the file
function positions(text, n) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length && out.length < 200; i++) {
    const m = /\b[a-zA-Z_]\w*\.(?=[a-zA-Z_])/.exec(lines[i]);
    if (m) out.push({ line: i, character: m.index + m[0].length });
  }
  const step = Math.max(1, Math.floor(out.length / n));
  return out.filter((_, i) => i % step === 0).slice(0, n);
}

function memTree(pid) {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='tsc.exe'" | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.WorkingSetSize)" }`;
  const rows = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' })
    .trim()
    .split(/\r?\n/)
    .map((l) => l.split(' ').map(Number));
  const set = new Set([pid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [p, pp] of rows)
      if (set.has(pp) && !set.has(p)) {
        set.add(p);
        grew = true;
      }
  }
  return rows.filter(([p]) => set.has(p)).map(([p, , ws]) => ({ pid: p, mb: Math.round(ws / 1048576) }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('S6 spawn:', cmd, args.join(' '));
  const ls = start();
  const initT = performance.now();
  const init = await ls.request('initialize', {
    processId: process.pid,
    rootUri: uri(''),
    workspaceFolders: [{ uri: uri(''), name: 'root' }],
    capabilities: {
      general: { positionEncodings: ['utf-16'] },
      textDocument: {
        completion: {
          completionItem: {
            snippetSupport: true,
            insertReplaceSupport: true,
            resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] },
          },
        },
        hover: { contentFormat: ['markdown', 'plaintext'] },
        definition: { linkSupport: true },
        publishDiagnostics: {},
      },
    },
  });
  console.log('S2 initialize ms:', Math.round(performance.now() - initT));
  if (init.error) { console.log('initialize error:', JSON.stringify(init.error)); process.exit(1); }
  console.log('S3 positionEncoding:', init.result.capabilities.positionEncoding);
  console.log('   completionProvider:', JSON.stringify(init.result.capabilities.completionProvider));
  console.log('   textDocumentSync:', JSON.stringify(init.result.capabilities.textDocumentSync));
  ls.notify('initialized', {});

  const text = fs.readFileSync(path.join(root, file), 'utf8');
  ls.notify('textDocument/didOpen', { textDocument: { uri: uri(file), languageId: 'typescript', version: 1, text } });
  const pos = positions(text, 11);
  // first completion = time to first availability
  const firstT = performance.now();
  const first = await ls.request('textDocument/completion', { textDocument: { uri: uri(file) }, position: pos[0] });
  console.log(
    'S2 first completion ms:',
    Math.round(performance.now() - firstT),
    'items:',
    first.result?.items?.length ?? first.result?.length,
    'since spawn:',
    Math.round(performance.now() - ls.t0),
  );
  const times = [];
  for (const p of pos.slice(1)) {
    const t = performance.now();
    const r = await ls.request('textDocument/completion', { textDocument: { uri: uri(file) }, position: p });
    times.push(performance.now() - t);
    console.log(`   L${p.line + 1}:${p.character} ${Math.round(times.at(-1))}ms items=${r.result?.items?.length ?? r.result?.length ?? 'null'}`);
  }
  console.log('S2 warm completion p50:', Math.round(pct(times, 0.5)), 'p95:', Math.round(pct(times, 0.95)));
  // hover + definition sanity
  const h = await ls.request('textDocument/hover', { textDocument: { uri: uri(file) }, position: pos[1] });
  console.log('   hover contents:', Array.isArray(h.result?.contents) ? 'array' : typeof h.result?.contents, h.result?.contents?.kind);
  const d = await ls.request('textDocument/definition', { textDocument: { uri: uri(file) }, position: pos[1] });
  console.log('   definition:', JSON.stringify(d.result)?.slice(0, 200));

  // S4: .tsx as typescript vs typescriptreact
  const tsx = fs.readFileSync(path.join(root, tsxFile), 'utf8');
  async function diagCount(languageId) {
    const u = uri(tsxFile);
    ls.notif.length = 0;
    ls.notify('textDocument/didOpen', { textDocument: { uri: u, languageId, version: 1, text: tsx } });
    // tsgo advertises pull diagnostics (diagnosticProvider) instead of publishDiagnostics
    const pulledItems = init.result.capabilities.diagnosticProvider
      ? (await ls.request('textDocument/diagnostic', { textDocument: { uri: u } })).result?.items
      : undefined;
    const pulled = pulledItems?.length;
    await sleep(2000);
    ls.notify('textDocument/didClose', { textDocument: { uri: u } });
    await sleep(500);
    const diags = ls.notif.filter((n) => n.method === 'textDocument/publishDiagnostics' && n.params.uri === u);
    const sample = pulled !== undefined ? pulledItems?.[0] : diags.at(-1)?.params.diagnostics[0];
    console.log('   sample diagnostic:', JSON.stringify(sample)?.slice(0, 300));
    return pulled ?? (diags.length ? diags.at(-1).params.diagnostics.length : 'none');
  }
  const order = process.env.SPIKE_ORDER === 'react-first' ? ['typescriptreact', 'typescript'] : ['typescript', 'typescriptreact'];
  for (const id of order) console.log(`S4 .tsx as ${id}: diagnostics =`, await diagCount(id));

  console.log('S5 memory (LS + tsserver tree):', JSON.stringify(memTree(ls.child.pid)));
  console.log('   other notifications seen:', [...new Set(ls.notif.map((n) => n.method))].join(', '));
  const sdT = performance.now();
  const sd = await Promise.race([ls.request('shutdown', null), sleep(5000).then(() => 'TIMEOUT')]);
  console.log('   shutdown:', sd === 'TIMEOUT' ? 'no response in 5s' : `${Math.round(performance.now() - sdT)}ms`);
  ls.notify('exit', null);
  const exited = await Promise.race([new Promise((r) => ls.child.on('exit', (c) => r(`exit code ${c}`))), sleep(3000).then(() => 'still alive after 3s')]);
  console.log('   after exit notification:', exited);
  ls.child.kill();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
