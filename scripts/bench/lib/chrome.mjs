// Chrome discovery / launch / isolated teardown for the bench harness.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function candidates() {
  return [
    process.env['ProgramFiles'] && path.join(process.env['ProgramFiles'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['LocalAppData'] && path.join(process.env['LocalAppData'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);
}

export function findChrome(override) {
  if (override) {
    if (!fs.existsSync(override)) throw new Error(`chrome.exe が見つかりません: ${override}`);
    return override;
  }
  for (const c of candidates()) {
    if (c && fs.existsSync(c)) return c;
  }
  throw new Error('chrome.exe が見つかりません (--chrome で明示指定してください)');
}

export function launchChrome({ exe, cdpPort, userDataDir, windowSize = '1600,1000' }) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    // crashpad handler がプロファイルのファイルハンドルを kill 直後まで保持することがあり、
    // 後始末の rmSync を落とす原因になる (実測)。計測用の使い捨てプロファイルなので切る。
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--no-crash-upload',
    `--window-size=${windowSize}`,
    'about:blank',
  ];
  // stdio: 'ignore' — 自プロセスの pid だけを掴んで後始末する (罠7: user-data-dir で
  // 他エージェントの Chrome と混同しない。ここでは spawn した子の pid をそのまま使うので
  // tasklist によるプロセス探索より確実)。
  return spawn(exe, args, { stdio: 'ignore', windowsHide: true });
}

export async function waitForCdp(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`Chrome CDP (port ${port}) が起動しませんでした`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** 自分が spawn した Chrome の pid ツリーだけを kill する (taskkill /T で子孫プロセスも含む)。 */
export function killChromeTree(pid) {
  if (!pid) return;
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    // 既に終了している場合など
  }
}
