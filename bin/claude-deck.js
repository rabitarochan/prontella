#!/usr/bin/env node
// Launcher for `npx @rabitarochan/claude-deck` — starts the server and opens a browser.
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`claude-deck — Git worktree × Claude Code agent deck

使い方:
  claude-deck [オプション]

オプション:
  --port <n>   待ち受けポート (既定: 3711)
  --no-open    起動時にブラウザを開かない
  -h, --help   このヘルプを表示

サーバーは 127.0.0.1 のみで待ち受けます。ブラウザを閉じても
ターミナルセッションはサーバーが生きている限り維持されます。`);
  process.exit(0);
}

function argValue(name) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
}

const port = argValue('--port') ?? process.env.PORT ?? '3711';
process.env.PORT = port;
process.env.NODE_ENV ??= 'production';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(__dirname, '../dist/server/index.js');
if (!existsSync(serverEntry)) {
  console.error('ビルド済みサーバーが見つかりません。リポジトリーから実行している場合は `npm run build` を先に実行してください。');
  process.exit(1);
}

await import(pathToFileURL(serverEntry).href);

const url = `http://localhost:${port}`;

async function waitReady(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/repos`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function openBrowser(target) {
  const [cmd, cmdArgs] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', target]]
      : process.platform === 'darwin'
        ? ['open', [target]]
        : ['xdg-open', [target]];
  try {
    spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true }).unref();
  } catch {
    // opening is best-effort; the URL is printed below
  }
}

if (await waitReady()) {
  if (!args.includes('--no-open')) openBrowser(url);
  console.log(`[claude-deck] ${url} で起動しました (Ctrl+C で終了)`);
} else {
  console.error(`[claude-deck] サーバーの起動を確認できませんでした: ${url}`);
}
