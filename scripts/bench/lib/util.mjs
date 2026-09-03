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
/**
 * pid とその子孫プロセスの CPU 時間 (秒) と RSS の合計。
 *
 * サーバーは `node tsx/cli.mjs server/index.ts` で起動するが、tsx は実体を子プロセスで
 * 走らせるため、親 pid だけを見ると CPU が常に 0 になる (実測: baseline で 0.000)。
 * node-pty が spawn する pwsh (シェル自体) も子孫に含まれるので、`children` に
 * 名前別の内訳を残し、サーバー本体 (node) とシェル (pwsh) を分けて読めるようにする。
 */
export function sampleProcess(pid) {
  const script = [
    '$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name',
    `$ids = New-Object System.Collections.Generic.List[int]; $ids.Add(${pid})`,
    '$i = 0; while ($i -lt $ids.Count) { $cur = $ids[$i]; foreach ($p in $all) { if ($p.ParentProcessId -eq $cur -and -not $ids.Contains([int]$p.ProcessId)) { $ids.Add([int]$p.ProcessId) } }; $i++ }',
    '$rows = foreach ($id in $ids) { $p = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p) { "$($p.ProcessName)|$($p.CPU)|$($p.WorkingSet64)" } }',
    '$rows -join ";"',
  ].join('; ');
  try {
    const out = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', script], {
      encoding: 'utf8',
    }).trim();
    let cpu = 0;
    let rss = 0;
    const children = {};
    for (const row of out.split(';').filter(Boolean)) {
      const [name, c, r] = row.split('|');
      const cn = Number(c);
      const rn = Number(r);
      if (Number.isFinite(cn)) cpu += cn;
      if (Number.isFinite(rn)) rss += rn;
      const entry = (children[name] ??= { count: 0, cpuSeconds: 0, rssBytes: 0 });
      entry.count += 1;
      if (Number.isFinite(cn)) entry.cpuSeconds += cn;
      if (Number.isFinite(rn)) entry.rssBytes += rn;
    }
    if (Object.keys(children).length === 0) return { cpuSeconds: null, rssBytes: null, children };
    return { cpuSeconds: cpu, rssBytes: rss, children };
  } catch {
    return { cpuSeconds: null, rssBytes: null, children: {} };
  }
}

/** sampleProcess の 2 標本から、プロセス名ごとの CPU 秒差分 (node = サーバー本体、pwsh = シェル)。 */
export function cpuDeltaByName(before, after) {
  const out = {};
  for (const [name, a] of Object.entries(after.children ?? {})) {
    const b = before.children?.[name];
    out[name] = Number((a.cpuSeconds - (b?.cpuSeconds ?? 0)).toFixed(3));
  }
  return out;
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
