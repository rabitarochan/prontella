// Isolated prontella server lifecycle (spawn / ready-wait / kill) for the bench harness.
// 罠2 (pj-isolated-verify): Volta シムは USERPROFILE 差し替え後に LocalAppData を見失って
// 死ぬため、実体 node.exe (= process.execPath。子プロセスとして実行しているこの harness
// 自身の execPath が既に実体を指している) で tsx の CLI を直叩きする。
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/bench/lib -> scripts/bench -> scripts -> <project root>
export const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const TSX_CLI = path.join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const SERVER_ENTRY = path.join(PROJECT_ROOT, 'server', 'index.ts');

export function spawnServer({ home, port }) {
  const logs = [];
  const child = spawn(process.execPath, [TSX_CLI, SERVER_ENTRY], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, USERPROFILE: home, HOME: home, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));
  return { child, logs };
}

export async function waitForServerReady(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/repos`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`server (port ${port}) が起動しませんでした`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

export async function waitForPortReleased(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/repos`, { signal: AbortSignal.timeout(500) });
    } catch {
      return; // 接続に失敗した = 解放された
    }
    if (Date.now() > deadline) return; // 深追いしない (vt/ 削除は gitignore 済みで実害なし)
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** taskkill でプロセスツリーごと止める (tsx が起動する子プロセスの取りこぼしを避ける)。 */
export function killServer(child) {
  if (!child || child.pid == null) return;
  try {
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    try { child.kill(); } catch {}
  }
}
