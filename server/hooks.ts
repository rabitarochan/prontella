import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Claude Code の hooks でステータスを検知するための仕組み。
// 「✦ Claude 起動」時に `claude --settings <hook-settings.json>` を注入し、
// 各フックイベントを **HTTP hook** で直接デッキサーバーへ POST させる。
// どのセッションからのイベントかは、PTY に載せた環境変数 CLAUDE_DECK_TERM を
// リクエストヘッダーへ補間して識別する。
//
// Why HTTP hook (2026-08-30 実測で採用):
// - 転送スクリプト (旧 deck-hook.mjs) が不要になり、hook 1 発ごとの node 起動が消える。
//   PreToolUse/PostToolUse は**サブエージェント内のツールでも**発火するため、
//   プロセス起動コストは本数分だけ積み上がっていた。
// - 生ペイロードがそのまま届く。旧実装は hook_event_name / message / notification_type の
//   3 つしか転送しておらず、tool_name・tool_input・agent_id・background_tasks を捨てていた。
//
// TUI 文言ヒューリスティック (pty.ts) は、手動起動した claude や hooks が届かない
// ケースのフォールバックとして残してある。

const ASSET_DIR = path.join(os.homedir(), '.claude-deck3');
const SETTINGS_PATH = path.join(ASSET_DIR, 'hook-settings.json');
/** 旧実装の転送スクリプト。HTTP hook 化で不要になったので起動時に掃除する。 */
const LEGACY_SCRIPT_PATH = path.join(ASSET_DIR, 'deck-hook.mjs');

/** hook が deck の応答を待つ上限 (秒)。ローカル往復なので短くてよい。 */
const HOOK_TIMEOUT_SEC = 3;

// 購読するイベント。◎ = 2026-08-30 に実測で発火を確認、△ = 未計測。
// △ のイベントは「状態を保つ/精緻化する」向きにしかマッピングしていないので、
// 発火しなくても届いても、誤って実行中を解除することはない (claudeHookState.ts 参照)。
const HOOK_EVENTS = [
  'SessionStart', //        △ print モードでは出ない。対話起動でのみ出る
  'UserPromptSubmit', //    ◎
  'PreToolUse', //          ◎ (agent_id 付きで子のツールも届く)
  'PostToolUse', //         ◎
  'PostToolUseFailure', //  △
  'PermissionRequest', //   △ 対話ダイアログでのみ出る
  'Notification', //        △ 対話ダイアログでのみ出る (既存実装が依存)
  'Stop', //                ◎ background_tasks を伴う
  'StopFailure', //         △
  'SubagentStart', //       ◎ agent_id / agent_type
  'SubagentStop', //        ◎
  'TeammateIdle', //        △
  'PostCompact', //         △ 手動 /compact の唯一の解除信号
  'SessionEnd', //          ◎
] as const;

let cached: { port: number; path: string } | null = null;

/** フック設定 JSON を ~/.claude-deck3 に書き出し、そのパスを返す。 */
export function ensureHookAssets(port: number): string {
  if (cached && cached.port === port) return cached.path;
  fs.mkdirSync(ASSET_DIR, { recursive: true });
  try {
    fs.rmSync(LEGACY_SCRIPT_PATH, { force: true });
  } catch {
    // 消せなくても実害はない (もう誰も呼ばない)
  }
  // matcher を省略した 1 エントリー = 全ツール/全イベントにマッチ。
  const entry = [{ hooks: [buildHttpHook(port)] }];
  const settings = {
    hooks: Object.fromEntries(HOOK_EVENTS.map((event) => [event, entry])),
  };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
  cached = { port, path: SETTINGS_PATH };
  return SETTINGS_PATH;
}

/**
 * HTTP hook 1 個ぶんの定義。
 * `${CLAUDE_DECK_TERM}` の補間には allowedEnvVars への明示列挙が必要
 * (未列挙の $VAR は空文字に潰される)。`${VAR}` `$VAR` どちらの書式も実測で通る。
 */
function buildHttpHook(port: number): Record<string, unknown> {
  return {
    type: 'http',
    url: `http://127.0.0.1:${port}/api/agent-events`,
    timeout: HOOK_TIMEOUT_SEC,
    headers: { 'X-Deck-Term': '${CLAUDE_DECK_TERM}' },
    allowedEnvVars: ['CLAUDE_DECK_TERM'],
  };
}

/** 「✦ Claude 起動」で PTY に流すコマンドライン。 */
export function claudeCommand(port: number): string {
  try {
    return `claude --settings "${ensureHookAssets(port)}"`;
  } catch {
    // 資材が書けない環境でも起動自体は諦めない (ヒューリスティック検知のみになる)
    return 'claude';
  }
}

/**
 * ユーザー設定が deck の HTTP hook を弾く設定になっていないかを調べる。
 * `--settings` の hooks はユーザー設定と**マージ**されるが、allowedHttpHookUrls /
 * allowedEnvVars は設定ソース横断でマージされ、**交差**で効くため、ユーザー側の
 * 指定次第で deck の hook が丸ごと無効化されうる。起動時に 1 回だけ警告する。
 */
export function warnIfHooksBlocked(port: number, warn: (message: string) => void): void {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8');
  } catch {
    return; // 無い / 読めないなら制限も無い
  }
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  const urls = config.allowedHttpHookUrls;
  if (Array.isArray(urls) && !urls.some((p) => typeof p === 'string' && matchesUrlPattern(p, port))) {
    warn(
      `~/.claude/settings.json の allowedHttpHookUrls が http://127.0.0.1:${port}/api/agent-events を許可していません。` +
        'エージェントのステータス検知は TUI ヒューリスティックのみになります。',
    );
  }
  const envVars = config.allowedEnvVars;
  if (Array.isArray(envVars) && !envVars.includes('CLAUDE_DECK_TERM')) {
    warn(
      '~/.claude/settings.json の allowedEnvVars に CLAUDE_DECK_TERM が含まれていません。' +
        'hook のセッション識別ができず、ステータス検知は TUI ヒューリスティックのみになります。',
    );
  }
}

/** allowedHttpHookUrls のパターン (`*` のみワイルドカード) が deck の URL に当たるか。 */
export function matchesUrlPattern(pattern: string, port: number): boolean {
  const target = `http://127.0.0.1:${port}/api/agent-events`;
  // `*` で分割してから各片を正規表現エスケープし、`.*` で繋ぎ直す。
  // 置換で一時プレースホルダーを挟むと、その文字自体がパターンに含まれたときに壊れる。
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, (ch) => `\\${ch}`))
    .join('.*');
  return new RegExp(`^${source}$`).test(target);
}
