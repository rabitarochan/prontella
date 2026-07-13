import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Claude Code の hooks でステータスを検知するための仕組み。
// 「✦ Claude 起動」時に `claude --settings <hook-settings.json>` を注入し、
// 各フックイベントを deck-hook.mjs 経由でデッキサーバーへ POST させる。
// どのセッションからのイベントかは PTY に載せた環境変数
// (CLAUDE_DECK_PORT / CLAUDE_DECK_TERM) で識別する。
//
// TUI 文言ヒューリスティック (pty.ts) は、手動起動した claude や
// hooks が届かないケースのフォールバックとしてそのまま併用する。

const ASSET_DIR = path.join(os.homedir(), '.claude-deck3');
const SCRIPT_PATH = path.join(ASSET_DIR, 'deck-hook.mjs');
const SETTINGS_PATH = path.join(ASSET_DIR, 'hook-settings.json');

// stdin のフックイベント JSON をデッキサーバーへ転送する。エージェントの動作を
// 一切妨げないよう、何が起きても exit 0 で終える (fetch 失敗・JSON 不正も無視)。
const HOOK_SCRIPT = `// claude-deck3 が自動生成するフック転送スクリプト (編集しても次回起動時に上書きされます)
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', async () => {
  const port = process.env.CLAUDE_DECK_PORT;
  const term = process.env.CLAUDE_DECK_TERM;
  if (!port || !term) process.exit(0);
  let event = {};
  try { event = JSON.parse(raw); } catch {}
  try {
    await fetch('http://127.0.0.1:' + port + '/api/agent-events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        term,
        event: typeof event.hook_event_name === 'string' ? event.hook_event_name : '',
        message: typeof event.message === 'string' ? event.message : '',
        notificationType: typeof event.notification_type === 'string' ? event.notification_type : '',
      }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {}
  process.exit(0);
});
`;

const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SessionEnd',
] as const;

let cachedSettingsPath: string | null = null;

/** フック資材 (転送スクリプト + 設定 JSON) を ~/.claude-deck3 に書き出す。 */
export function ensureHookAssets(): string {
  if (cachedSettingsPath) return cachedSettingsPath;
  fs.mkdirSync(ASSET_DIR, { recursive: true });
  fs.writeFileSync(SCRIPT_PATH, HOOK_SCRIPT, 'utf8');
  // matcher を省略した 1 エントリー = 全ツール/全イベントにマッチ。
  const entry = [{ hooks: [{ type: 'command', command: `node "${SCRIPT_PATH}"`, timeout: 10 }] }];
  const settings = {
    hooks: Object.fromEntries(HOOK_EVENTS.map((event) => [event, entry])),
  };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
  cachedSettingsPath = SETTINGS_PATH;
  return SETTINGS_PATH;
}

/** 「✦ Claude 起動」で PTY に流すコマンドライン。 */
export function claudeCommand(): string {
  try {
    return `claude --settings "${ensureHookAssets()}"`;
  } catch {
    // 資材が書けない環境でも起動自体は諦めない (ヒューリスティック検知のみになる)
    return 'claude';
  }
}
