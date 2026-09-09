// Isolated browser verification of the client metrics path (pj-isolated-verify):
// isolated USERPROFILE + port, built client served by the tsx server, headless Chrome via CDP.
//
//   npm run build && node scripts/metrics/browser-check.mjs [port=4781] [cdpPort=9741] [tier=dev]
//
// Checks: client snapshots arrive through /api/metrics/ingest, gauges include js.heap.used
// (performance.memory), http spans carry route templates only, sendBeacon on navigation,
// /api/metrics/export returns a gzip bundle whose first line is meta, ingest rejects bad input,
// and summarize.mjs renders the collected data. Work dir: vt/metrics-bc-<pid> (removed at the end).
// Never touches the real ~/.prontella or the running instance (ports 3711/8110).
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { findChrome, waitForCdp, killChromeTree } from '../bench/lib/chrome.mjs';
import { connectBrowser, newPage, evaluate, navigate, delay } from '../bench/lib/cdp.mjs';
import { spawnServer, waitForServerReady, killServer } from '../bench/lib/server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');
const WORK = path.join(ROOT, 'vt', `metrics-bc-${process.pid}`);
const HOME = path.join(WORK, 'home');
const PORT = Number(process.argv[2] ?? 4781);
const CDP = Number(process.argv[3] ?? 9741);
const TIER = process.argv[4] ?? 'dev';
fs.mkdirSync(HOME, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

process.env.PRONTELLA_METRICS = TIER;
const { child: server, logs } = spawnServer({ home: HOME, port: PORT });
let chrome = null;
let browser = null;
try {
  await waitForServerReady(PORT, 180_000);
  const metricsDir = path.join(HOME, '.prontella', 'metrics', TIER);
  const readAll = () => {
    if (!fs.existsSync(metricsDir)) return [];
    return fs.readdirSync(metricsDir).filter((f) => f.endsWith('.jsonl')).flatMap((f) =>
      fs.readFileSync(path.join(metricsDir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    );
  };

  const exe = findChrome();
  chrome = spawn(exe, [
    `--remote-debugging-port=${CDP}`, `--user-data-dir=${path.join(WORK, 'profile')}`, '--headless=new',
    '--no-first-run', '--no-default-browser-check', '--disable-crash-reporter', '--disable-breakpad', '--no-crash-upload',
    '--window-size=1400,900', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  await waitForCdp(CDP);
  browser = await connectBrowser(CDP);
  const page = await newPage(browser, `http://127.0.0.1:${PORT}/`);
  const pageStart = Date.now();
  await delay(2000);
  const title = await evaluate(browser, page.sessionId, 'document.title', false);
  check('page loaded', typeof title === 'string', JSON.stringify(title));

  const cfg = await evaluate(browser, page.sessionId, `fetch('/api/metrics/config').then(r => r.json())`);
  check('client sees tier', cfg?.tier === TIER, JSON.stringify(cfg));
  const hasMemory = await evaluate(browser, page.sessionId, `'memory' in performance`, false);
  check('(d) performance.memory present in this Chrome', hasMemory === true, String(hasMemory));

  // dev: sample 5s + send 10s. Wait for two send intervals.
  console.log('waiting 22s for client batches...');
  await delay(22_000);
  let recs = readAll();
  const client = recs.filter((r) => r.src === 'client');
  const clientSnapshots = client.filter((r) => r.k === 'snapshot');
  check('client snapshots ingested', clientSnapshots.length >= 1, `${clientSnapshots.length} snapshots, ${client.length} client records`);
  const gaugeNames = new Set(clientSnapshots.flatMap((s) => (s.gauges ?? []).map((g) => g.n)));
  check('js.heap.used gauge (performance.memory)', gaugeNames.has('js.heap.used'), [...gaugeNames].join(','));
  check('ws.links gauge', gaugeNames.has('ws.links'));
  // /ws/events は bootMetrics (config の fetch) より先に開くので、初回の open 相転移は観測されない
  // (再接続だけが対象)。フレームは観測フック配線後から数える。
  const wsCounters = clientSnapshots.flatMap((s) => (s.counters ?? []).filter((c) => c.n.startsWith('ws.')));
  const wsPaths = new Set(wsCounters.map((c) => c.l?.path));
  check('liveSocket observer counts frames per path', wsCounters.some((c) => c.n === 'ws.frames.in' && c.v > 0) && wsPaths.has('/ws/events'), [...wsPaths].join(','));
  const httpHist = clientSnapshots.flatMap((s) => (s.hist ?? []).filter((h) => h.n === 'http'));
  const routes = new Set(httpHist.map((h) => h.l?.route));
  check('client http spans use route templates', httpHist.length > 0 && [...routes].every((r) => /^\/api\/[a-z/:-]+$/.test(r) || r === 'unmatched'), [...routes].join(','));
  const tabs = new Set(client.map((r) => r.tab));
  check('tab id is 8 hex', [...tabs].every((t) => /^[0-9a-f]{8}$/.test(t)), [...tabs].join(','));
  const beforeNav = client.length;

  // (c) navigate away → pagehide → sendBeacon(application/json Blob) → express.json parses it.
  // dev: サンプル 5 秒 / 送信 10 秒。25 秒のサンプルがキューに乗り、30 秒の送信より前 (≈27 秒) に離脱する。
  const target = pageStart + 27_000;
  if (Date.now() < target) await delay(target - Date.now());
  await navigate(browser, page.sessionId, 'about:blank');
  await delay(3000);
  recs = readAll();
  const afterNav = recs.filter((r) => r.src === 'client').length;
  check('(c) beacon on pagehide delivered more client records', afterNav > beforeNav, `${beforeNav} → ${afterNav}`);

  // export bundle
  const res = await fetch(`http://127.0.0.1:${PORT}/api/metrics/export`);
  const buf = Buffer.from(await res.arrayBuffer());
  const text = zlib.gunzipSync(buf).toString('utf8');
  const first = JSON.parse(text.split('\n')[0]);
  check('export is gzip with meta first line', res.headers.get('content-type') === 'application/gzip' && first.k === 'meta' && first.bundle === 1, `${buf.length} bytes, files=${res.headers.get('x-prontella-metrics-files')}`);
  check('export bundle has no hostname/username', !text.includes(process.env.USERNAME || 'no-username-env') && !text.includes(HOME));

  // ingest validation: oversize + garbage
  const bad = await fetch(`http://127.0.0.1:${PORT}/api/metrics/ingest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ records: 'x' }) });
  check('ingest rejects non-array (400)', bad.status === 400, String(bad.status));
  const big = await fetch(`http://127.0.0.1:${PORT}/api/metrics/ingest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ records: [{ k: 'stall', t: Date.now(), p: 'x'.repeat(300_000) }] }) });
  check('ingest rejects oversize (413)', big.status === 413, String(big.status));

  const summary = execFileSync(process.execPath, [path.join(ROOT, 'scripts/metrics/summarize.mjs'), '--dir', metricsDir, '--tier', TIER], { encoding: 'utf8' });
  check('summarize runs on browser data', summary.includes('Client tabs') && summary.includes('### 4. Wasted work'));
  console.log(summary.split('\n').slice(0, 12).join('\n'));
} catch (err) {
  check('script completed', false, err instanceof Error ? err.stack ?? err.message : String(err));
  console.log(logs.join('').slice(-2000));
} finally {
  try { browser?.ws.close(); } catch {}
  killChromeTree(chrome?.pid);
  killServer(server);
  await delay(1500);
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) { console.log('cleanup left', WORK, String(e)); }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exitCode = failed ? 1 : 0;
}
