import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 条件ポーリング (固定 sleep は使わない)。
 * 計測フェーズ中の呼び出しは intervalMs >= 250 を守ること (ハーネス自身の CDP
 * ポーリングが計測を汚さないようにするため。README/ブリーフ参照)。
 */
export async function waitFor(fn, { timeoutMs = 30_000, intervalMs = 250, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label} (${timeoutMs}ms)`);
    await delay(intervalMs);
  }
}

/** ディレクトリー配下の最新 mtime (ms)。node_modules/.git は除外。 */
export function maxMtimeMs(dir, skipDirs = new Set(['node_modules', '.git'])) {
  let max = 0;
  function walk(d) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && skipDirs.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else {
        try {
          const st = fs.statSync(p);
          if (st.mtimeMs > max) max = st.mtimeMs;
        } catch {
          // race with concurrent write — skip
        }
      }
    }
  }
  walk(dir);
  return max;
}

/**
 * サーバープロセスの CPU 時間 (秒) と RSS (bytes) をサンプルする。
 * PowerShell `Get-Process` 経由 (罠19 と同種の理由: 隔離 USERPROFILE 下でも
 * node.exe を直接呼ばずシェル組み込みで完結させたいところだが、こちらは
 * ハーネス自身のプロセスから powershell.exe を叩くだけなので Volta は関係ない)。
 */
export function sampleProcess(pid) {
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-Command', `$p = Get-Process -Id ${pid} -ErrorAction Stop; "$($p.CPU)|$($p.WorkingSet64)"`],
      { encoding: 'utf8' },
    ).trim();
    const [cpu, rss] = out.split('|').map(Number);
    return { cpuSeconds: Number.isFinite(cpu) ? cpu : null, rssBytes: Number.isFinite(rss) ? rss : null };
  } catch {
    return { cpuSeconds: null, rssBytes: null };
  }
}

/**
 * Chrome の crashpad handler 等が数百 ms だけファイルハンドルを保持していることがあり、
 * kill 直後の rmSync が 1 回で通らないことがある (実測: bench-smoke-43796 の
 * `chrome/Default/**` が丸ごと残存)。指数バックオフで数回だけ再試行する。
 */
export async function rmDirWithRetry(dir, { attempts = 5, delayMs = 500 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      if (!fs.existsSync(dir)) return true;
    } catch {
      // retry
    }
    await delay(delayMs * (i + 1));
  }
  return !fs.existsSync(dir);
}

export function fmtNum(n, digits = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return 'n/a';
  return Number(n).toFixed(digits);
}

export function fmtBytes(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return 'n/a';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}
