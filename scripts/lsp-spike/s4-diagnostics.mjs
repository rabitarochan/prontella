// Phase 2 spike: pull diagnostics / signatureHelp / references response shapes and timing,
// for both tsgo (TS 7) and Roslyn. Results go to RESULTS.md before implementing.
//
// Usage: node scripts/lsp-spike/s4-diagnostics.mjs <root> <file>
//   SPIKE_CMD / SPIKE_ARGS   launch (default: the root's tsgo `tsc.exe --lsp --stdio`)
//   SPIKE_SOLUTION           .sln to `solution/open` (Roslyn) — waits for projectInitializationComplete
//   SPIKE_SIG "line:char"    position for signatureHelp (0-based; default: after the first `ident(` call)
//   SPIKE_REF "line:char"    position for references (default: first exported/public function name)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2]);
const file = process.argv[3];
if (!file) throw new Error('usage: s4-diagnostics.mjs <root> <file>');
const abs = path.resolve(root, file);
const ext = path.extname(abs).toLowerCase();
const languageId = ext === '.cs' ? 'csharp' : ext === '.tsx' ? 'typescriptreact' : 'typescript';
const tsgo = path.join(root, 'node_modules', '@typescript', `typescript-${process.platform}-${process.arch}`, 'lib', process.platform === 'win32' ? 'tsc.exe' : 'tsc');
const cmd = process.env.SPIKE_CMD ?? tsgo;
const args = process.env.SPIKE_ARGS
  ? process.env.SPIKE_ARGS.split(' ')
  : languageId === 'csharp'
    ? ['--stdio', '--logLevel', 'Information', '--extensionLogDirectory', path.join(os.tmpdir(), 'prontella-roslyn-spike'), '--clientProcessId', String(process.pid)]
    : ['--lsp', '--stdio'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uri = (p) => pathToFileURL(p).href;
const t0 = performance.now();
const ms = () => Math.round(performance.now() - t0);
const short = (v, n = 300) => JSON.stringify(v)?.slice(0, n);

console.log('spawn:', cmd, args.join(' '));
const child = spawn(cmd, args, { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); if (process.env.SPIKE_STDERR) fs.appendFileSync(process.env.SPIKE_STDERR, d); });
child.on('exit', (code, sig) => console.log(`[exit] code=${code} sig=${sig} at ${ms()}ms stderr=${stderr.slice(-600)}`));

let buf = Buffer.alloc(0);
const pending = new Map();
let nextId = 1;
let projectInitAt = null;
const pushes = []; // publishDiagnostics { at, uri, count }
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
      if (msg.method === 'workspace/configuration') send({ jsonrpc: '2.0', id: msg.id, result: msg.params.items.map(() => null) });
      else send({ jsonrpc: '2.0', id: msg.id, result: null });
    } else {
      if (msg.method === 'workspace/projectInitializationComplete') projectInitAt = ms();
      if (msg.method === 'window/logMessage' && process.env.SPIKE_LOG) fs.appendFileSync(process.env.SPIKE_LOG, `[${msg.params.type}] ${msg.params.message}
`);
      if (msg.method === 'textDocument/publishDiagnostics') pushes.push({ at: ms(), uri: msg.params.uri, count: msg.params.diagnostics.length, version: msg.params.version });
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

function parsePos(s) {
  const [l, c] = s.split(':').map(Number);
  return { line: l, character: c };
}
function findPos(text, re, group) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (m) return { line: i, character: m.index + m[0].indexOf(m[group]) + (group === 0 ? m[0].length : 0), src: lines[i].trim().slice(0, 70) };
  }
  return null;
}
function timedPull(u, previousResultId) {
  const t = performance.now();
  return request('textDocument/diagnostic', { textDocument: { uri: u }, ...(previousResultId ? { previousResultId } : {}) }, 120_000).then((r) => ({ r, dt: Math.round(performance.now() - t) }));
}
function describeDiag(r) {
  if (r.error) return `ERROR ${short(r.error)}`;
  const res = r.result;
  if (!res) return 'null';
  const items = res.items ?? [];
  const sev = {};
  for (const d of items) sev[d.severity ?? 'none'] = (sev[d.severity ?? 'none'] ?? 0) + 1;
  const codes = [...new Set(items.map((d) => typeof d.code + (d.codeDescription ? '+desc' : '')))];
  const tags = [...new Set(items.flatMap((d) => d.tags ?? []))];
  const rel = items.filter((d) => d.relatedInformation?.length).length;
  return `kind=${res.kind} resultId=${res.resultId === undefined ? 'none' : typeof res.resultId} items=${items.length} severity=${short(sev)} codeTypes=${short(codes)} tags=${short(tags)} withRelated=${rel} data=${res.data !== undefined}`;
}
async function pullUntil(u, pred, maxMs = 15_000) {
  const start = performance.now();
  let last;
  for (;;) {
    last = await timedPull(u);
    if (pred(last.r) || performance.now() - start > maxMs) return { ...last, total: Math.round(performance.now() - start) };
    await sleep(100);
  }
}

async function signatureAndReferences(text, u) {
  // ---- S: signatureHelp
  const sigPos = process.env.SPIKE_SIG ? parsePos(process.env.SPIKE_SIG) : findPos(text, /\b[a-zA-Z_]\w*\(/, 0);
  if (sigPos) {
    console.log(`S signatureHelp at ${sigPos.line}:${sigPos.character} :: ${sigPos.src ?? ''}`);
    for (const ctx of [{ triggerKind: 1, isRetrigger: false }, { triggerKind: 2, triggerCharacter: '(', isRetrigger: false }]) {
      const t = performance.now();
      const r = await request('textDocument/signatureHelp', { textDocument: { uri: u }, position: sigPos, context: ctx }, 30_000);
      const res = r.result;
      console.log(`   ctx=${short(ctx)} ${Math.round(performance.now() - t)}ms →`, r.error ? 'ERROR ' + short(r.error) : res === null ? 'null' : `signatures=${res.signatures.length} activeSignature=${res.activeSignature} activeParameter=${res.activeParameter}`);
      if (res?.signatures?.[0]) {
        const s = res.signatures[0];
        console.log('   sig[0]:', short({ label: s.label, docType: typeof s.documentation === 'object' ? s.documentation.kind : typeof s.documentation, activeParameter: s.activeParameter, params: s.parameters?.map((p) => ({ label: p.label, doc: typeof p.documentation })) }, 400));
      }
    }
  }

  // ---- R: references
  const refPos = process.env.SPIKE_REF
    ? parsePos(process.env.SPIKE_REF)
    : languageId === 'csharp'
      ? findPos(text, /public\s+(?:async\s+)?[\w<>\[\]?]+\s+(\w+)\s*\(/, 1)
      : findPos(text, /export\s+(?:async\s+)?function\s+(\w+)/, 1);
  if (refPos) {
    const hv = await request('textDocument/hover', { textDocument: { uri: u }, position: refPos }, 30_000);
    console.log(`H hover at ref position: ${hv.error ? 'ERROR' : short(hv.result?.contents, 120)} | line text: ${JSON.stringify(text.split(/\r?\n/)[refPos.line]?.slice(0, 80))}`);
    console.log(`R references at ${refPos.line}:${refPos.character} :: ${refPos.src ?? ''}`);
    const t = performance.now();
    const r = await request('textDocument/references', { textDocument: { uri: u }, position: refPos, context: { includeDeclaration: true } }, 60_000);
    const list = r.result ?? [];
    const rootN = uri(root).toLowerCase();
    const ext = list.filter((l) => !(l.uri ?? l.targetUri).toLowerCase().startsWith(rootN));
    console.log(`   ${Math.round(performance.now() - t)}ms →`, r.error ? 'ERROR ' + short(r.error) : `${list.length} results, shape=${list[0] ? ('targetUri' in list[0] ? 'LocationLink' : 'Location') : 'n/a'}, files=${new Set(list.map((l) => l.uri ?? l.targetUri)).size}, outsideRoot=${ext.length}`);
    for (const l of list.slice(0, 3)) console.log('   ', short(l, 200));
    // Roslyn: does it return metadata references?
    if (ext[0]) console.log('   outside sample:', short(ext[0], 200));
  }

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
        completion: { completionItem: { snippetSupport: true } },
        hover: { contentFormat: ['markdown', 'plaintext'] },
        definition: { linkSupport: true },
        publishDiagnostics: { relatedInformation: true, tagSupport: { valueSet: [1, 2] }, codeDescriptionSupport: true },
        diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
        signatureHelp: {
          signatureInformation: { documentationFormat: ['markdown', 'plaintext'], parameterInformation: { labelOffsetSupport: true }, activeParameterSupport: true },
          contextSupport: true,
        },
        references: {},
      },
      workspace: { configuration: false, workspaceFolders: true },
    },
  });
  if (init.error) {
    console.log('initialize ERROR', short(init.error));
    process.exit(1);
  }
  const caps = init.result.capabilities;
  console.log(`initialize ${ms()}ms serverInfo=${short(init.result.serverInfo)}`);
  console.log('  diagnosticProvider:', short(caps.diagnosticProvider));
  console.log('  signatureHelpProvider:', short(caps.signatureHelpProvider));
  console.log('  referencesProvider:', short(caps.referencesProvider));
  notify('initialized', {});
  if (process.env.SPIKE_SOLUTION) {
    notify('solution/open', { solution: uri(path.resolve(process.env.SPIKE_SOLUTION)) });
  }

  const text = fs.readFileSync(abs, 'utf8');
  const u = uri(abs);
  notify('textDocument/didOpen', { textDocument: { uri: u, languageId, version: 1, text } });
  if (process.env.SPIKE_SOLUTION) {
    const until = performance.now() + 180_000;
    while (projectInitAt === null && performance.now() < until) await sleep(250);
    console.log(`projectInitializationComplete: ${projectInitAt ?? 'NOT RECEIVED'}ms`);
  }

  // ---- D1: first pull after didOpen
  const d1 = await timedPull(u);
  console.log(`D1 pull after didOpen: ${d1.dt}ms ${describeDiag(d1.r)}`);
  const items1 = d1.r.result?.items ?? [];
  for (const d of items1.slice(0, 3)) console.log('   sample:', short({ range: d.range, severity: d.severity, code: d.code, codeDescription: d.codeDescription, source: d.source, tags: d.tags, message: String(d.message).slice(0, 60), relatedInformation: d.relatedInformation?.slice(0, 1) }, 400));
  console.log(`   pushes so far: ${pushes.length} ${short(pushes.slice(0, 3))}`);

  if (process.env.SPIKE_SR_FIRST) await signatureAndReferences(text, u);

  // ---- D2: pull again with previousResultId (unchanged?)
  if (d1.r.result?.resultId) {
    const d2 = await timedPull(u, d1.r.result.resultId);
    console.log(`D2 re-pull with previousResultId: ${d2.dt}ms ${describeDiag(d2.r)}`);
  }

  // ---- D3: didChange (append a syntax error) → how long until the pull reflects it
  const bad = languageId === 'csharp' ? '\nclass __Spike { void M() { int = ; } }\n' : '\nconst = ;\n';
  const lineCount = text.split('\n').length;
  const lastLine = text.split('\n').at(-1);
  const tChange = performance.now();
  notify('textDocument/didChange', {
    textDocument: { uri: u, version: 2 },
    contentChanges: [{ range: { start: { line: lineCount - 1, character: lastLine.length }, end: { line: lineCount - 1, character: lastLine.length } }, rangeLength: 0, text: bad }],
  });
  const d3 = await pullUntil(u, (r) => (r.result?.items?.length ?? 0) > items1.length);
  console.log(`D3 after didChange(+syntax error): first pull that reflects it after ${d3.total}ms (last pull ${d3.dt}ms) ${describeDiag(d3.r)}`);
  const newItems = (d3.r.result?.items ?? []).filter((d) => d.range.start.line >= lineCount - 1);
  for (const d of newItems.slice(0, 3)) console.log('   new:', short({ range: d.range, severity: d.severity, code: d.code, source: d.source, message: String(d.message).slice(0, 80) }));
  console.log(`   pushes after change: ${pushes.filter((p) => p.at > tChange - t0).length} ${short(pushes.slice(-2))}`);

  // ---- D4: revert (full text) → pull returns to baseline
  // incremental revert (delete the appended text). A range-less full-text change is tested last (D5):
  // Roslyn crashes on it (NullReferenceException in ProtocolConversions.RangeToLinePositionSpan)
  const badLines = bad.split('\n');
  notify('textDocument/didChange', {
    textDocument: { uri: u, version: 3 },
    contentChanges: [
      {
        range: { start: { line: lineCount - 1, character: lastLine.length }, end: { line: lineCount - 1 + badLines.length - 1, character: badLines.at(-1).length } },
        rangeLength: bad.length,
        text: '',
      },
    ],
  });
  const d4 = await pullUntil(u, (r) => (r.result?.items?.length ?? -1) === items1.length);
  console.log(`D4 after incremental revert: back to ${items1.length} items after ${d4.total}ms`);

  if (!process.env.SPIKE_SR_FIRST) await signatureAndReferences(text, u);

  // ---- D5: full-text didChange (ownership transfer in session.ts sends this form). Does the server survive?
  notify('textDocument/didChange', { textDocument: { uri: u, version: 4 }, contentChanges: [{ text }] });
  const d5 = await timedPull(u);
  console.log(`D5 full-text didChange → pull: ${d5.dt}ms ${describeDiag(d5.r)} alive=${child.exitCode === null}`);

  console.log(`\npushes total: ${pushes.length}`);
  await request('shutdown', null, 5_000);
  notify('exit', null);
  await sleep(1500);
  if (child.exitCode === null) child.kill();
}
main().catch((e) => {
  console.error(e);
  child.kill();
  process.exit(1);
});
