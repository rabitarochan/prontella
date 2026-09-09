import { HOOK_EVENTS } from '../hooks.js';
import { TIERS } from './config.js';

/**
 * メトリクスの語彙 (唯一のソース)。
 *
 * 匿名層 (anon) の記録は scrub.ts がここにある閉じた集合だけを通す。文字列値を持てる
 * キーはこのファイルに列挙されたものに限り、値もその語彙内でなければレコードごと落ちる。
 * 新しいメトリクス名・ラベル値を使うときはここに足す (足し忘れは「記録されない」側に倒れる
 * ので、漏洩ではなく欠測として現れる)。
 */

export const RECORD_KINDS = [
  'meta', // 起動時 1 回: version / node / platform
  'snapshot', // 定期サンプル (プロセス統計 + カウンター/ゲージ/ヒストグラム要約)
  'slow', // しきい値を超えた span
  'hang', // イベントループ/メインスレッドの長時間ブロック
  'stall', // クライアントのタイマードリフト
  'rafgap', // クライアントの rAF 停止
  'ws', // WebSocket の相転移 (再接続)
  'session', // セッションの生成/終了
  'self', // 計測自身の異常 (drop 等)
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

/** メトリクス名 (span / counter / gauge / histogram 共通)。動的な部分はラベルに出す。 */
export const METRIC_NAMES = [
  // ---- server: HTTP / git
  'http',
  'git',
  // ---- server: PTY
  'pty.chunk',
  'pty.chunk.chars',
  'pty.flush',
  'pty.flush.bytes',
  'pty.flush.unwatched.bytes',
  'pty.flush.burst',
  'pty.scan',
  'mirror.snapshot',
  'pty.attach',
  'pty.reattach',
  'pty.resize.changed',
  'pty.resize.noop',
  'activity.publish',
  'activity.coalesced',
  // ---- server: Agent SDK / hooks / events
  'sdk.msg',
  'sdk.turn',
  'sdk.firstDelta',
  'hook.event',
  'hook.unknownTerm',
  'events.broadcast',
  'events.noSubscribers',
  // ---- server: WebSocket
  'ws.open',
  'ws.frames.in',
  'ws.frames.out',
  'ws.bytes.in',
  'ws.bytes.out',
  'ws.send.skipped',
  // ---- server: polling waste
  'repos.poll.changed',
  'repos.poll.unchanged',
  'repos.poll.gitCalls',
  // ---- both: sessions
  'session.create',
  'session.exit',
  // ---- self
  'metrics.self.serialize',
  'metrics.self.dropped',
  'metrics.self.scrubDropped',
  'metrics.self.written',
  'metrics.self.ingestDropped',
  'metrics.self.beaconTruncated',
  // ---- client: timing
  'longtask',
  'input',
  'xterm.write',
  'react.commit',
  // ---- client: waste
  'xterm.write.visible.bytes',
  'xterm.write.hidden.bytes',
  'xterm.deferred.overflow',
  'xterm.deferred.discarded.bytes',
  'resize.fit',
  'resize.sent',
  'repos.refresh.changed',
  'repos.refresh.unchanged',
  'repos.poll.tick',
  'store.set',
  'chat.msg',
  'chat.delta.chars',
  // ---- client: leak gauges
  'webgl.lost',
  'webgl.created',
  'webgl.disposed',
  'ws.phase',
  'xterm.instances',
  'canvas.count',
  'monaco.models',
  'tiles',
  'ws.links',
  'chat.events',
  'js.heap.used',
  'js.heap.total',
] as const;
export type MetricName = (typeof METRIC_NAMES)[number];

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export const STATUS_CLASSES = ['1xx', '2xx', '3xx', '4xx', '5xx'] as const;
export const GIT_SUBCOMMANDS = [
  'status', 'log', 'diff', 'show', 'fetch', 'pull', 'push', 'worktree', 'branch', 'rev-parse',
  'for-each-ref', 'stash', 'apply', 'merge', 'rebase', 'cherry-pick', 'revert', 'reset', 'tag',
  'remote', 'blame', 'ls-files', 'check-ref-format', 'init', 'commit', 'switch', 'checkout', 'add',
  'rm', 'restore', 'cat-file', 'ls-tree', 'symbolic-ref', 'config', 'describe', 'update-ref',
  'other',
] as const;
export const WS_PATHS = ['/ws/term', '/ws/agent', '/ws/events', '/ws/vnc'] as const;
export const LINK_PHASES = ['connecting', 'open', 'reconnecting', 'gone'] as const;
export const VIEWS = ['files', 'git', 'term', 'chat'] as const;
export const AGENT_STATUSES = ['busy', 'waiting', 'idle', 'shell'] as const;
export const SESSION_KINDS = ['pty', 'sdk'] as const;
export const ATTRIBUTIONS = ['window', 'iframe', 'unknown', 'xterm', 'monaco-editor', 'tile-pane', 'tree', 'other'] as const;
export const SDK_MESSAGE_TYPES = ['system', 'stream_event', 'assistant', 'user', 'result', 'other'] as const;
export const CHAT_MESSAGE_TYPES = [
  'snapshot', 'event', 'delta', 'status', 'meta', 'commands', 'models', 'stats', 'subagents',
  'permission_request', 'exit', 'error', 'other',
] as const;
export const STORES = ['deck', 'agentEvents', 'pageActivity', 'tileLayout', 'termState', 'editorGroups', 'fileEntries', 'other'] as const;
export const SIDES = ['server', 'client'] as const;
export const DIRECTIONS = ['in', 'out'] as const;
export const SPAN_PHASES = ['s', 'e'] as const;
export const PLATFORMS = ['win32', 'linux', 'darwin', 'other'] as const;
export const ARCHS = ['x64', 'arm64', 'other'] as const;
/** アクティブ状態のラベル (可視かつフォーカス)。 */
export const ACTIVITY = ['active', 'inactive'] as const;

/** 8 桁の 16 進乱数 (run id / tab id)。 */
export const SHORT_ID_RE = /^[0-9a-f]{8}$/;

/**
 * HTTP ルートの閉じた語彙。server/index.ts で `app.<method>('/api/...')` として登録された
 * テンプレートそのもの + 固定の分類名 (spa / static / unmatched)。
 * 形状の正規表現では base64url の repo id や 8 桁の terminal id がテンプレートと区別できず
 * 素通りする (scrub.test.ts で実証) ため、列挙にする。names.test.ts が index.ts と突き合わせて
 * ドリフトを検出する — ルートを足したらここにも足す。
 */
export const ROUTES = [
  'spa',
  'static',
  'unmatched',
  '/api/agent-events',
  '/api/agents',
  '/api/agents/resumable',
  '/api/agents/resumable/:id/discard',
  '/api/editor/open',
  '/api/editor/status',
  '/api/fs/copy',
  '/api/fs/delete',
  '/api/fs/dir',
  '/api/fs/editorconfig',
  '/api/fs/file',
  '/api/fs/git-status',
  '/api/fs/raw',
  '/api/fs/rename',
  '/api/fs/reveal',
  '/api/fs/tree',
  '/api/git/apply-hunks',
  '/api/git/blame',
  '/api/git/branch-delete',
  '/api/git/branch-delete-remote',
  '/api/git/branch-fetch-ff',
  '/api/git/branch-push',
  '/api/git/branch-rename',
  '/api/git/cherry-pick',
  '/api/git/commit',
  '/api/git/commit-files',
  '/api/git/commit-message',
  '/api/git/diff',
  '/api/git/diff-hunks',
  '/api/git/diff-pair',
  '/api/git/discard',
  '/api/git/discard-all',
  '/api/git/fetch',
  '/api/git/init',
  '/api/git/log',
  '/api/git/merge',
  '/api/git/merge-abort',
  '/api/git/operation',
  '/api/git/pull',
  '/api/git/push',
  '/api/git/rebase',
  '/api/git/remote-add',
  '/api/git/remote-remove',
  '/api/git/remote-set-url',
  '/api/git/remotes',
  '/api/git/reset',
  '/api/git/resolve-side',
  '/api/git/revert',
  '/api/git/stage',
  '/api/git/stage-all',
  '/api/git/stash',
  '/api/git/stash-apply',
  '/api/git/stash-drop',
  '/api/git/stash-show',
  '/api/git/status',
  '/api/git/switch',
  '/api/git/tag-create',
  '/api/git/tag-delete',
  '/api/git/tag-delete-remote',
  '/api/git/tag-push',
  '/api/git/tags',
  '/api/git/undo-commit',
  '/api/git/unstage',
  '/api/git/unstage-all',
  '/api/metrics/config',
  '/api/metrics/export',
  '/api/metrics/ingest',
  '/api/repos',
  '/api/repos/:id',
  '/api/repos/:id/branches',
  '/api/repos/:id/worktrees',
  '/api/repos/order',
  '/api/search/files',
  '/api/search/text',
  '/api/terminals',
  '/api/terminals/:id/kill',
  '/api/usage',
  '/api/vnc/status',
] as const;
export const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
export const NODE_VERSION_RE = /^v\d+\.\d+\.\d+$/;

export type StringRule = { readonly vocab: ReadonlySet<string> } | { readonly re: RegExp };

const vocab = (values: readonly string[]): StringRule => ({ vocab: new Set(values) });

/**
 * 文字列値を持てるキーと、その値の規則。ここに無いキーの文字列値は anon では不許可。
 * ネストの深さに関係なく同じキー名には同じ規則を適用する (`l.route` も `route` も同じ)。
 */
export const STRING_RULES: Readonly<Record<string, StringRule>> = {
  k: vocab(RECORD_KINDS),
  n: vocab(METRIC_NAMES),
  run: { re: SHORT_ID_RE },
  tab: { re: SHORT_ID_RE },
  src: vocab(SIDES),
  side: vocab(SIDES),
  tier: vocab(TIERS),
  route: vocab(ROUTES),
  method: vocab(HTTP_METHODS),
  sc: vocab(STATUS_CLASSES),
  git: vocab(GIT_SUBCOMMANDS),
  path: vocab(WS_PATHS),
  phase: vocab(LINK_PHASES),
  view: vocab(VIEWS),
  status: vocab(AGENT_STATUSES),
  kind: vocab(SESSION_KINDS),
  attr: vocab(ATTRIBUTIONS),
  hook: vocab(HOOK_EVENTS),
  sdk: vocab(SDK_MESSAGE_TYPES),
  msg: vocab(CHAT_MESSAGE_TYPES),
  store: vocab(STORES),
  dir: vocab(DIRECTIONS),
  ph: vocab(SPAN_PHASES),
  platform: vocab(PLATFORMS),
  arch: vocab(ARCHS),
  act: vocab(ACTIVITY),
  version: { re: SEMVER_RE },
  node: { re: NODE_VERSION_RE },
};

const METRIC_NAME_SET: ReadonlySet<string> = new Set(METRIC_NAMES);
export function isMetricName(name: string): name is MetricName {
  return METRIC_NAME_SET.has(name);
}

export function statusClass(statusCode: number): (typeof STATUS_CLASSES)[number] {
  if (statusCode >= 500) return '5xx';
  if (statusCode >= 400) return '4xx';
  if (statusCode >= 300) return '3xx';
  if (statusCode >= 200) return '2xx';
  return '1xx';
}

const GIT_SET: ReadonlySet<string> = new Set(GIT_SUBCOMMANDS);
/** git の引数列から先頭のサブコマンドを取り出し、語彙外なら 'other' に潰す。 */
export function gitSubcommand(args: readonly string[]): (typeof GIT_SUBCOMMANDS)[number] {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-c' || a === '-C') {
      i += 1; // 値を伴うオプションは次を飛ばす
      continue;
    }
    if (a.startsWith('-')) continue;
    return GIT_SET.has(a) ? (a as (typeof GIT_SUBCOMMANDS)[number]) : 'other';
  }
  return 'other';
}

export function platformLabel(p: string): (typeof PLATFORMS)[number] {
  return p === 'win32' || p === 'linux' || p === 'darwin' ? p : 'other';
}

export function archLabel(a: string): (typeof ARCHS)[number] {
  return a === 'x64' || a === 'arm64' ? a : 'other';
}
