#!/usr/bin/env node
// Reproducible perf harness for the terminal panel (prontella / feature/terminal-monitor).
// See scripts/bench/README.md for usage, prerequisites, and metric definitions.
// See .claude/skills/pj-isolated-verify/SKILL.md for the isolation traps this avoids.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  addInitScript, bringToFront, connectBrowser, delay, diffMetrics, dragSeparator,
  evaluate, getMetrics, METRIC_KEYS, newPage, newWindow, performanceEnable,
  rectOfNth, rectOfSplitButton, reload as cdpReload, navigate, trustedClick,
} from './lib/cdp.mjs';
import { benchInstrumentationScript, monitorInitScript, selectionInitScript } from './lib/inject.mjs';
import { findChrome, killChromeTree, launchChrome, waitForCdp } from './lib/chrome.mjs';
import { PROJECT_ROOT, killServer, spawnServer, waitForPortReleased, waitForServerReady } from './lib/server.mjs';
import { addRepo, createTerminal, getRepos, killTerminal, openTermWs, waitOpen } from './lib/api.mjs';
import { cpuDeltaByName, fmtBytes, fmtNum, maxMtimeMs, rmDirWithRetry, sampleProcess, waitFor } from './lib/util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, 'results');
const LOAD_PS1 = path.join(__dirname, 'load.ps1');

// ---- CLI --------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    label: null, sessions: 6, seconds: 20, hz: 10, lines: 20,
    port: 4751, cdp: 9733, chrome: null, keep: false, force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--label': out.label = next(); break;
      case '--sessions': out.sessions = Number(next()); break;
      case '--seconds': out.seconds = Number(next()); break;
      case '--hz': out.hz = Number(next()); break;
      case '--lines': out.lines = Number(next()); break;
      case '--port': out.port = Number(next()); break;
      case '--cdp': out.cdp = Number(next()); break;
      case '--chrome': out.chrome = next(); break;
      case '--keep': out.keep = true; break;
      case '--force': out.force = true; break;
      default: throw new Error(`unknown arg: ${a}`);
    }
  }
  if (!out.label) throw new Error('--label is required');
  if (!/^[a-zA-Z0-9_-]+$/.test(out.label)) throw new Error('--label は英数字/-/_ のみ');
  return out;
}

// ---- prerequisite check -------------------------------------------------------

function checkBuildFresh(force) {
  const distIndex = path.join(PROJECT_ROOT, 'client', 'dist', 'index.html');
  if (!fs.existsSync(distIndex)) {
    if (force) { console.warn('[bench] client/dist/index.html が無い (--force で続行)'); return; }
    throw new Error('client/dist/index.html が無い。先に `npm run build` してください (--force で無視可)');
  }
  const distMtime = maxMtimeMs(path.join(PROJECT_ROOT, 'client', 'dist'));
  const srcMtime = maxMtimeMs(path.join(PROJECT_ROOT, 'client', 'src'));
  if (distMtime < srcMtime) {
    const msg = `client/dist が client/src より古い (dist=${new Date(distMtime).toISOString()} < src=${new Date(srcMtime).toISOString()}). npm run build してください`;
    if (force) { console.warn(`[bench] ${msg} (--force で続行)`); return; }
    throw new Error(msg);
  }
}

function gitInfo() {
  const run = (args) => {
    try { return execFileSync('git', args, { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim(); }
    catch { return null; }
  };
  return { commit: run(['rev-parse', 'HEAD']), branch: run(['rev-parse', '--abbrev-ref', 'HEAD']) };
}

function depVersions() {
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  return {
    node: process.version,
    xterm: pkg.devDependencies?.['@xterm/xterm'] ?? null,
    nodePty: pkg.dependencies?.['node-pty'] ?? null,
  };
}

// ---- isolated fixture setup ---------------------------------------------------

function gitQuiet(args, cwd) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function setupIsolatedRepo(repo1) {
  fs.mkdirSync(repo1, { recursive: true });
  gitQuiet(['init'], repo1);
  gitQuiet(['config', 'core.autocrlf', 'false'], repo1); // 罠1: 隔離ホームは ~/.gitconfig が見えない
  gitQuiet(['config', 'user.email', 'bench@example.invalid'], repo1);
  gitQuiet(['config', 'user.name', 'term-bench'], repo1);
  fs.writeFileSync(path.join(repo1, 'README.md'), '# term-bench fixture\n');
  gitQuiet(['add', '-A'], repo1);
  gitQuiet(['commit', '-m', 'init'], repo1);
}

// ---- browser-side helpers ------------------------------------------------------

async function waitXtermCount(browser, sessionId, selector, expected, timeoutMs) {
  return waitFor(
    async () => {
      const n = await evaluate(browser, sessionId, `document.querySelectorAll(${JSON.stringify(selector)}).length`);
      return n >= expected;
    },
    { timeoutMs, intervalMs: 300, label: `${selector} count>=${expected}` },
  );
}

async function snapshot(browser, sessionId) {
  return evaluate(browser, sessionId, 'window.__benchSnapshot ? window.__benchSnapshot() : null');
}

function termPath(snap) {
  return snap?.byPath?.['/ws/term'] ?? { sent: {}, received: {}, bytesReceived: 0, bytesSent: 0, bytesByTypeReceived: {}, socketCount: 0 };
}

function diffCounts(before, after) {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const out = {};
  for (const k of keys) out[k] = (after?.[k] ?? 0) - (before?.[k] ?? 0);
  return out;
}

// ---- main -----------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  checkBuildFresh(args.force);
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const vtRoot = path.join(PROJECT_ROOT, 'vt', `bench-${args.label}-${process.pid}`);
  const home = path.join(vtRoot, 'home');
  const repo1 = path.join(vtRoot, 'repo1');
  const chromeProfile = path.join(vtRoot, 'chrome');
  fs.mkdirSync(home, { recursive: true });

  let serverHandle = null;
  let chromeChild = null;
  let browser = null;
  const verificationSockets = [];
  const sessionIds = []; // 作成した PTY セッション id。cleanup で明示的に kill する。

  const cleanup = async () => {
    for (const ws of verificationSockets) { try { ws.close(); } catch {} }
    if (browser) { try { browser.ws.close(); } catch {} } // 自分の CDP セッションを切るだけ (--keep でも常に閉じてよい)
    if (args.keep) {
      console.log(
        `[bench] --keep 指定のため後始末をスキップします。\n` +
        `  vt:     ${vtRoot}\n` +
        `  server: pid=${serverHandle?.child?.pid ?? 'n/a'} http://127.0.0.1:${args.port}\n` +
        `  chrome: pid=${chromeChild?.pid ?? 'n/a'} cdp=${args.cdp}\n` +
        `  手動で後始末する場合: taskkill /PID <pid> /T /F` +
        ` のあと vt/bench-${args.label}-${process.pid} を削除してください。`,
      );
      return;
    }
    // taskkill /T は node-pty (ConPTY) が生んだシェル (pwsh.exe) を子プロセスとして
    // 拾えないことがある (実測: サーバー kill 後も -NoLogo な pwsh.exe が生き残り、
    // 隔離 home 配下のファイルハンドルを握ったまま vt/ の削除を失敗させた)。
    // サーバーがまだ生きているうちに API 経由で ptyManager.kill() を明示的に呼ぶ。
    if (serverHandle && !serverHandle.child.killed) {
      for (const id of sessionIds) {
        try { await killTerminal(args.port, id); } catch { /* サーバーが既に不応答なら諦める */ }
      }
    }
    if (chromeChild) killChromeTree(chromeChild.pid);
    if (serverHandle) {
      killServer(serverHandle.child);
      await waitForPortReleased(args.port);
    }
    const ok = await rmDirWithRetry(vtRoot);
    if (!ok) console.warn(`[bench] 隔離環境の削除に失敗 (ロック残存の可能性): ${vtRoot} — 罠13: 深追いしない`);
  };

  let sigintHandled = false;
  const onSigint = () => {
    if (sigintHandled) return;
    sigintHandled = true;
    console.warn('\n[bench] SIGINT — 後始末してから終了します');
    cleanup().finally(() => process.exit(130));
  };
  process.on('SIGINT', onSigint);

  try {
    console.log(`[bench] label=${args.label} sessions=${args.sessions} seconds=${args.seconds} hz=${args.hz} lines=${args.lines}`);
    console.log(`[bench] isolated env: ${vtRoot}`);

    setupIsolatedRepo(repo1);

    serverHandle = spawnServer({ home, port: args.port });
    await waitForServerReady(args.port, 60_000).catch((e) => {
      console.error('[bench] server logs:\n' + serverHandle.logs.join(''));
      throw e;
    });
    console.log(`[bench] server ready: http://127.0.0.1:${args.port}`);

    const repoRes = await addRepo(args.port, repo1);
    const repos = await getRepos(args.port);
    const registered = repos.find((r) => r.id === repoRes.id);
    const worktreePath = registered?.worktrees?.[0]?.path ?? repoRes.path;

    for (let i = 0; i < args.sessions; i++) {
      const s = await createTerminal(args.port, worktreePath);
      sessionIds.push(s.id);
    }
    console.log(`[bench] created ${sessionIds.length} pty sessions on ${worktreePath}`);

    const chromeExe = findChrome(args.chrome);
    chromeChild = launchChrome({ exe: chromeExe, cdpPort: args.cdp, userDataDir: chromeProfile });
    await waitForCdp(args.cdp, 20_000);
    browser = await connectBrowser(args.cdp);
    console.log('[bench] chrome ready');

    // ---- page A (worktree) ----
    const pageA = await newPage(browser, 'about:blank');
    await addInitScript(browser, pageA.sessionId, benchInstrumentationScript() + selectionInitScript(repoRes.id, worktreePath));
    await performanceEnable(browser, pageA.sessionId);
    await navigate(browser, pageA.sessionId, `http://127.0.0.1:${args.port}/`);
    await waitXtermCount(browser, pageA.sessionId, '.xterm', args.sessions, 45_000);
    console.log('[bench] page A (worktree) attached');

    // ---- page B (monitor, separate window) ----
    const pageB = await newWindow(browser, 'about:blank');
    await addInitScript(browser, pageB.sessionId, benchInstrumentationScript() + monitorInitScript());
    await performanceEnable(browser, pageB.sessionId);
    await navigate(browser, pageB.sessionId, `http://127.0.0.1:${args.port}/`);
    await waitXtermCount(browser, pageB.sessionId, '.monitor-view .xterm', args.sessions, 45_000);
    console.log('[bench] page B (monitor) attached');

    // ============================================================
    // M2: steady (load.ps1 into every session while page B is front)
    // (M1 は M2 の後に測る: 負荷で各セッションのスクロールバックが埋まった
    //  状態で attach しないと、snapshot の再生コストが測れない)
    // ============================================================
    console.log('[bench] M2: steady...');
    await bringToFront(browser, pageB.sessionId);
    await delay(300); // bringToFront/フォーカス反映待ち

    for (const id of sessionIds) {
      const ws = openTermWs(args.port, id);
      verificationSockets.push(ws);
      await waitOpen(ws);
      const cmd = `& '${LOAD_PS1.replace(/'/g, "''")}' -Seconds ${args.seconds} -Hz ${args.hz} -Lines ${args.lines} -Cols 100 -Ticks ${args.seconds * args.hz}\r`;
      ws.send(JSON.stringify({ type: 'input', data: cmd }));
    }

    const serverPid = serverHandle.child.pid;
    const cpuBefore = sampleProcess(serverPid);
    const m2PerfABefore = await getMetrics(browser, pageA.sessionId);
    const m2PerfBBefore = await getMetrics(browser, pageB.sessionId);
    const m2SnapABefore = await snapshot(browser, pageA.sessionId);
    const m2SnapBBefore = await snapshot(browser, pageB.sessionId);
    const wallStart = Date.now();

    // load.ps1 は tick 数固定 (= 仕事量固定) なので、混んでいると seconds より長くかかる。
    // 時間ではなく「data フレームが 1.5 秒止まる」= 全セッションが出し切ったことを待つ。
    await delay(args.seconds * 1000);
    {
      let last = termPath(await snapshot(browser, pageB.sessionId)).received?.data ?? 0;
      let quietSince = Date.now();
      await waitFor(
        async () => {
          const cur = termPath(await snapshot(browser, pageB.sessionId)).received?.data ?? 0;
          if (cur !== last) {
            last = cur;
            quietSince = Date.now();
          }
          return Date.now() - quietSince >= 1_500;
        },
        { timeoutMs: args.seconds * 3_000 + 10_000, intervalMs: 500, label: 'M2 output quiescent' },
      );
    }

    const wallSeconds = (Date.now() - wallStart) / 1000;
    const cpuAfter = sampleProcess(serverPid);
    const m2PerfAAfter = await getMetrics(browser, pageA.sessionId);
    const m2PerfBAfter = await getMetrics(browser, pageB.sessionId);
    const m2SnapAAfter = await snapshot(browser, pageA.sessionId);
    const m2SnapBAfter = await snapshot(browser, pageB.sessionId);

    for (const ws of verificationSockets.splice(0)) { try { ws.close(); } catch {} }

    const cpuSecondsPerWallSecond =
      cpuBefore.cpuSeconds !== null && cpuAfter.cpuSeconds !== null
        ? (cpuAfter.cpuSeconds - cpuBefore.cpuSeconds) / wallSeconds
        : null;

    const pageMetrics = (before, after, snapBefore, snapAfter) => {
      const tBefore = termPath(snapBefore);
      const tAfter = termPath(snapAfter);
      return {
        perf: diffMetrics(before, after, METRIC_KEYS),
        longtaskCount: snapAfter.longtasks.count - snapBefore.longtasks.count,
        longtaskMs: Number((snapAfter.longtasks.totalMs - snapBefore.longtasks.totalMs).toFixed(2)),
        wsFramesReceived: diffCounts(tBefore.received, tAfter.received),
        wsBytesReceived: tAfter.bytesReceived - tBefore.bytesReceived,
      };
    };

    const m2 = {
      wallSeconds: Number(wallSeconds.toFixed(2)),
      serverCpuSecondsPerWallSecond: cpuSecondsPerWallSecond === null ? null : Number(cpuSecondsPerWallSecond.toFixed(3)),
      // プロセス名別の CPU 秒 (node = サーバー本体、pwsh = node-pty が spawn したシェル = 負荷生成器自身)
      serverCpuByName: cpuDeltaByName(cpuBefore, cpuAfter),
      serverRssBytesBefore: cpuBefore.rssBytes,
      serverRssBytesAfter: cpuAfter.rssBytes,
      pageA: pageMetrics(m2PerfABefore, m2PerfAAfter, m2SnapABefore, m2SnapAAfter),
      pageB: pageMetrics(m2PerfBBefore, m2PerfBAfter, m2SnapBBefore, m2SnapBAfter),
    };
    console.log(`[bench] M2 serverCpu/wall=${fmtNum(m2.serverCpuSecondsPerWallSecond, 3)} pageB longtaskMs=${m2.pageB.longtaskMs}`);

    // ============================================================
    // M1: attach (page B reload -> all term sockets re-snapshot)
    // 各セッションのスクロールバックは M2 の負荷で埋まっている
    // ============================================================
    console.log('[bench] M1: attach (reload)...');
    const m1MetricsBefore = await getMetrics(browser, pageB.sessionId);
    const t1Start = Date.now();
    await cdpReload(browser, pageB.sessionId);
    await waitFor(
      async () => termPath(await snapshot(browser, pageB.sessionId)).received?.snapshot >= args.sessions,
      { timeoutMs: 60_000, intervalMs: 300, label: 'M1 all snapshots received' },
    );
    const attachMs = Date.now() - t1Start;
    await delay(3_000); // getMetrics/longtask window: reload から +3秒
    const m1MetricsAfter = await getMetrics(browser, pageB.sessionId);
    const m1Snap = termPath(await snapshot(browser, pageB.sessionId));
    // waitXtermCount 相当を再度張る (reload 後は DOM も作り直されている)
    await waitXtermCount(browser, pageB.sessionId, '.monitor-view .xterm', args.sessions, 45_000);
    const m1Perf = diffMetrics(m1MetricsBefore, m1MetricsAfter, METRIC_KEYS);
    const m1LongtasksAfter = (await snapshot(browser, pageB.sessionId)).longtasks;
    const m1 = {
      attachMs,
      snapshotBytes: m1Snap.bytesByTypeReceived?.snapshot ?? 0,
      snapshotCount: m1Snap.received?.snapshot ?? 0,
      perf: m1Perf,
      longtaskCount: m1LongtasksAfter.count,
      longtaskMs: Number(m1LongtasksAfter.totalMs.toFixed(2)),
    };
    console.log(`[bench] M1 attachMs=${attachMs} snapshotBytes=${fmtBytes(m1.snapshotBytes)}`);

    // ============================================================
    // M3: resize storm (split page A's group, drag the new separator)
    // ============================================================
    console.log('[bench] M3: resize storm (driver=worktree page A)...');
    await bringToFront(browser, pageA.sessionId);
    await delay(300);
    // 主張側判定 (client/src/lib/pageActivity.ts) は document.hasFocus() 依存。
    // Page.bringToFront が OS フォーカスまで取れないことがあるため、resize フレームが
    // 0 のときにここを見れば「主張側になれていない」ことをすぐ切り分けられる。
    const pageAFocus = await evaluate(browser, pageA.sessionId, '({ hasFocus: document.hasFocus(), visibilityState: document.visibilityState })');
    console.log(`[bench] page A focus check: hasFocus=${pageAFocus.hasFocus} visibilityState=${pageAFocus.visibilityState}`);
    let m3 = null;
    const splitBtn = await rectOfSplitButton(browser, pageA.sessionId);
    if (!splitBtn) {
      console.warn('[bench] M3 skipped: split button (.term-group .term-tab-buttons .codicon-split-horizontal) not found');
    } else {
      await trustedClick(browser, pageA.sessionId, splitBtn.x, splitBtn.y);
      // `.pane-separator` は FilesTab/GitTab のサイドバー幅調整にも使われており、それらは
      // 非アクティブでも display:none のまま常駐マウントされている (SplitPanel.tsx のコメント
      // 参照)。スコープなしの `.pane-separator` はそちらを先に拾ってしまい、ドラッグしても
      // 何も動かない (実測: resize フレーム 0 件で発覚)。ターミナルパネル配下に絞る。
      const SEPARATOR_SELECTOR = '.term-body .pane-separator';
      await waitFor(
        async () => (await rectOfNth(browser, pageA.sessionId, SEPARATOR_SELECTOR, 0)) !== null,
        { timeoutMs: 10_000, intervalMs: 300, label: 'M3 pane-separator visible' },
      );
      const sep = await rectOfNth(browser, pageA.sessionId, SEPARATOR_SELECTOR, 0);
      const m3SnapDriverBefore = await snapshot(browser, pageA.sessionId);
      const m3SnapOtherBefore = await snapshot(browser, pageB.sessionId);
      const m3CpuBefore = sampleProcess(serverPid);
      const dragStart = Date.now();
      await dragSeparator(browser, pageA.sessionId, sep.x, sep.y, sep.x + 200, sep.y, 30, 50);
      const dragMs = Date.now() - dragStart;
      const m3CpuAfter = sampleProcess(serverPid);
      const m3SnapDriverAfter = await snapshot(browser, pageA.sessionId);
      const m3SnapOtherAfter = await snapshot(browser, pageB.sessionId);
      const driverBefore = termPath(m3SnapDriverBefore);
      const driverAfter = termPath(m3SnapDriverAfter);
      const otherBefore = termPath(m3SnapOtherBefore);
      const otherAfter = termPath(m3SnapOtherAfter);
      const dragWallSeconds = dragMs / 1000;
      m3 = {
        driverPage: 'worktree(A)',
        driverFocus: pageAFocus,
        dragMs,
        resizeFramesSentByDriver: (driverAfter.sent?.resize ?? 0) - (driverBefore.sent?.resize ?? 0),
        resizeFramesReceivedByOther: (otherAfter.received?.resize ?? 0) - (otherBefore.received?.resize ?? 0),
        driverLongtaskCount: m3SnapDriverAfter.longtasks.count - m3SnapDriverBefore.longtasks.count,
        driverLongtaskMs: Number((m3SnapDriverAfter.longtasks.totalMs - m3SnapDriverBefore.longtasks.totalMs).toFixed(2)),
        serverCpuSecondsPerWallSecond:
          m3CpuBefore.cpuSeconds !== null && m3CpuAfter.cpuSeconds !== null
            ? Number(((m3CpuAfter.cpuSeconds - m3CpuBefore.cpuSeconds) / dragWallSeconds).toFixed(3))
            : null,
        serverCpuByName: cpuDeltaByName(m3CpuBefore, m3CpuAfter),
      };
      console.log(`[bench] M3 dragMs=${dragMs} resizeFramesSentByDriver=${m3.resizeFramesSentByDriver} resizeFramesReceivedByOther=${m3.resizeFramesReceivedByOther}`);
    }

    // ============================================================
    // M4: reconnect storm (close every term socket on page B)
    // ============================================================
    console.log('[bench] M4: reconnect...');
    const m4SnapBefore = termPath(await snapshot(browser, pageB.sessionId));
    const baselineSnapshotCount = m4SnapBefore.received?.snapshot ?? 0;
    const closed = await evaluate(browser, pageB.sessionId, "window.__benchCloseSockets('/ws/term')");
    const t4Start = Date.now();
    await waitFor(
      async () => (termPath(await snapshot(browser, pageB.sessionId)).received?.snapshot ?? 0) - baselineSnapshotCount >= args.sessions,
      { timeoutMs: 60_000, intervalMs: 300, label: 'M4 all sockets re-snapshotted' },
    );
    const reconnectMs = Date.now() - t4Start;
    const m4SnapAfter = await snapshot(browser, pageB.sessionId);
    const m4 = {
      closedSockets: closed,
      reconnectMs,
      longtaskCount: m4SnapAfter.longtasks.count - m1LongtasksAfter.count,
      longtaskMs: Number((m4SnapAfter.longtasks.totalMs - m1LongtasksAfter.totalMs).toFixed(2)),
    };
    console.log(`[bench] M4 reconnectMs=${reconnectMs}`);

    // ---- write result ----
    const result = {
      label: args.label,
      at: new Date().toISOString(),
      git: gitInfo(),
      versions: depVersions(),
      config: { sessions: args.sessions, seconds: args.seconds, hz: args.hz, lines: args.lines, port: args.port, cdp: args.cdp },
      m1, m2, m3, m4,
    };
    const outFile = path.join(RESULTS_DIR, `${args.label}.json`);
    fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
    console.log(`[bench] wrote ${outFile}`);
    printMarkdown(result);
  } finally {
    process.off('SIGINT', onSigint);
    await cleanup();
  }
}

function printMarkdown(r) {
  const rows = [
    ['M1 attach (ms)', r.m1.attachMs],
    ['M1 snapshot bytes', fmtBytes(r.m1.snapshotBytes)],
    ['M1 longtasks (count/ms)', `${r.m1.longtaskCount} / ${fmtNum(r.m1.longtaskMs)}`],
    ['M1 TaskDuration diff (s)', fmtNum(r.m1.perf.TaskDuration, 3)],
    ['M2 server CPU / wall (tree)', fmtNum(r.m2.serverCpuSecondsPerWallSecond, 3)],
    ['M2 server CPU s (node / pwsh)', `${fmtNum(r.m2.serverCpuByName?.node, 2)} / ${fmtNum(r.m2.serverCpuByName?.pwsh, 2)}`],
    ['M2 server RSS after', fmtBytes(r.m2.serverRssBytesAfter)],
    ['M2 pageA TaskDuration / Script (s)', `${fmtNum(r.m2.pageA.perf.TaskDuration, 2)} / ${fmtNum(r.m2.pageA.perf.ScriptDuration, 2)}`],
    ['M2 pageB TaskDuration / Script (s)', `${fmtNum(r.m2.pageB.perf.TaskDuration, 2)} / ${fmtNum(r.m2.pageB.perf.ScriptDuration, 2)}`],
    ['M2 pageA longtasks (count/ms)', `${r.m2.pageA.longtaskCount} / ${fmtNum(r.m2.pageA.longtaskMs)}`],
    ['M2 pageB longtasks (count/ms)', `${r.m2.pageB.longtaskCount} / ${fmtNum(r.m2.pageB.longtaskMs)}`],
    ['M2 pageA ws bytes received', fmtBytes(r.m2.pageA.wsBytesReceived)],
    ['M2 pageB ws bytes received', fmtBytes(r.m2.pageB.wsBytesReceived)],
    ['M3 drag (ms)', r.m3 ? r.m3.dragMs : 'n/a'],
    ['M3 resize sent(driver)/recv(other)', r.m3 ? `${r.m3.resizeFramesSentByDriver} / ${r.m3.resizeFramesReceivedByOther}` : 'n/a'],
    ['M3 server CPU / wall (drag)', r.m3 ? fmtNum(r.m3.serverCpuSecondsPerWallSecond, 3) : 'n/a'],
    ['M3 server CPU s (node / pwsh)', r.m3 ? `${fmtNum(r.m3.serverCpuByName?.node, 2)} / ${fmtNum(r.m3.serverCpuByName?.pwsh, 2)}` : 'n/a'],
    ['M4 reconnect (ms)', r.m4.reconnectMs],
    ['M4 longtasks (count/ms)', `${r.m4.longtaskCount} / ${fmtNum(r.m4.longtaskMs)}`],
  ];
  console.log(`\n## ${r.label} (${r.at})\n`);
  console.log('| metric | value |');
  console.log('| --- | --- |');
  for (const [k, v] of rows) console.log(`| ${k} | ${v} |`);
  console.log('');
}

main().catch((err) => {
  console.error('[bench] FAILED:', err);
  process.exitCode = 1;
});
