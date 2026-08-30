// Claude Code の hook イベントを畳み込んで、PTY セッションのステータスと
// 「いま何をしているか」を導く純関数の状態機械。副作用を持たないので単体テストできる。
//
// 判別器は **ペイロードの agent_id の有無だけ** (2026-08-30 実測):
// session_id も transcript_path も親子で同一のため使えない。子由来のイベントには
// agent_id が入り、リード (親) のイベントには入らない。
//
// 決定的な実測所見: リードの Stop は子の走行中に飛ぶ。並列 Explore 2 本のケースで
// Stop が 3 回飛び、最初の 2 回は background_tasks に running な子が載っていた。
// 「Stop → idle」の無条件マッピングが「実行中なのに待ち状態」の直接原因。
// 実測ログの要点は claudeHookState.test.ts のフィクスチャに写してある。

import type { AgentStatus } from './pty.js';
import { toolSummary } from './toolSummary.js';

const MAX_SUBAGENTS = 20;
const MAX_TEXT = 120;

/** background_tasks の status がこれらなら「終わっている」。それ以外は走行中とみなす。 */
const TERMINAL_TASK_STATUSES = new Set([
  'idle', 'done', 'success', 'succeeded', 'complete', 'completed', 'finished',
  'failed', 'error', 'terminated', 'exited', 'aborted', 'expired', 'skipped',
  'crashed', 'killed', 'cancelled', 'canceled', 'timed_out',
]);

/** ユーザーの対応を待たせる Notification の種別。message 正規表現より確実。 */
const WAITING_NOTIFICATIONS = /^(permission_prompt|elicitation_dialog|agent_needs_input)$/;

export interface HookSubagent {
  /** hook ペイロードの agent_id。background_tasks の id と一致する (実測)。 */
  id: string;
  /** agent_type (例 'Explore')。無ければ 'Agent'。 */
  name: string;
  description: string;
  startedAt: number;
  /** 子の最新ツール ("Grep: hooks")。 */
  activity: string;
  state: 'working' | 'idle';
}

export interface ClaudeHookState {
  /** リード (親) のターン状態。null = まだ何も観測していない。 */
  lead: 'working' | 'waiting' | 'idle' | null;
  /** リードが実行中のツール。 */
  tool: { name: string; detail: string; since: number } | null;
  subagents: Map<string, HookSubagent>;
  /** background_tasks にサブエージェント以外の走行中タスクが載っていた (表示用)。 */
  runningBackgroundTask: boolean;
  lastEventAt: number;
}

/**
 * Claude Code の hook ペイロードとして扱えるか。
 *
 * これを通らない POST でセッションを「hook 権威」に切り替えてはいけない。
 * 切り替わると TUI ヒューリスティックが降りるので、ゴミを 1 発投げるだけで
 * そのターミナルのステータス検知を殺せてしまう (/api/agent-events は認証を持たない)。
 */
export function isClaudeHookPayload(payload: Record<string, unknown>): boolean {
  return typeof payload.hook_event_name === 'string' && payload.hook_event_name.length > 0;
}

export function createHookState(now: number): ClaudeHookState {
  return {
    lead: null,
    tool: null,
    subagents: new Map(),
    runningBackgroundTask: false,
    lastEventAt: now,
  };
}

export interface HookEventResult {
  /** セッションに設定すべきステータス。null なら触らない。 */
  status: AgentStatus | null;
  /** ツール/サブエージェントの表示内容が変わった (ステータス据え置きでも配信が要る)。 */
  changed: boolean;
}

/** 1 イベントを state に畳み込む。state は破壊的に更新される。 */
export function applyClaudeHookEvent(
  state: ClaudeHookState,
  payload: Record<string, unknown>,
  now: number,
): HookEventResult {
  const event = readString(payload, 'hook_event_name');
  const agentId = readString(payload, 'agent_id');
  state.lastEventAt = now;

  // SessionEnd だけは親子を問わず終端。
  if (event === 'SessionEnd') {
    resetState(state);
    return { status: 'shell', changed: true };
  }

  const changed = agentId
    ? applyChildEvent(state, event, agentId, payload, now)
    : applyLeadEvent(state, event, payload, now);

  return { status: deriveStatus(state), changed };
}

/** 子 (サブエージェント) 由来のイベント。リードのターン状態とツールカードは触らない。 */
function applyChildEvent(
  state: ClaudeHookState,
  event: string,
  agentId: string,
  payload: Record<string, unknown>,
  now: number,
): boolean {
  switch (event) {
    case 'SubagentStart':
      return upsertSubagent(state, agentId, { name: readString(payload, 'agent_type') }, now);
    case 'SubagentStop':
      return state.subagents.delete(agentId);
    case 'TeammateIdle': {
      // 未計測のイベント。teammate は「ターン終了だがまだ生きている」= 完了ゲートを
      // 持たせない (idle にして行は残す)。届かなくても他の経路は壊れない。
      const tracked = state.subagents.get(agentId);
      if (!tracked || tracked.state === 'idle') return false;
      tracked.state = 'idle';
      return true;
    }
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const toolName = readString(payload, 'tool_name');
      return upsertSubagent(
        state,
        agentId,
        {
          name: readString(payload, 'agent_type'),
          activity: toolName ? toolSummary(toolName, payload.tool_input) : '',
        },
        now,
      );
    }
    case 'PermissionRequest':
      // 子がユーザーの許可を待っている = ペイン全体が待ち。
      state.lead = 'waiting';
      return true;
    case 'Notification':
      return applyNotification(state, payload);
    default:
      return false;
  }
}

/** リード (親) 由来のイベント。 */
function applyLeadEvent(
  state: ClaudeHookState,
  event: string,
  payload: Record<string, unknown>,
  now: number,
): boolean {
  switch (event) {
    case 'SessionStart':
      // 新しいプロセスがペインを持つ。前のセッションの子を引き継がせない。
      resetState(state);
      state.lead = 'idle';
      return true;
    case 'UserPromptSubmit':
      state.lead = 'working';
      state.tool = null;
      return true;
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      state.lead = 'working';
      const toolName = readString(payload, 'tool_name');
      if (toolName) {
        state.tool = { name: toolName, detail: toolSummary(toolName, payload.tool_input), since: now };
      }
      return true;
    }
    case 'PermissionRequest':
      state.lead = 'waiting';
      return true;
    case 'Notification':
      return applyNotification(state, payload);
    case 'Stop':
    case 'StopFailure':
      state.lead = 'idle';
      state.tool = null;
      // 走行中の子が残っていれば deriveStatus が busy を維持する。
      foldBackgroundTasks(state, payload);
      return true;
    case 'PostCompact':
      // 手動 /compact はアイドルプロンプトで終わり Stop を出さない。唯一の解除信号。
      if (payload.trigger !== 'manual') return false;
      state.lead = 'idle';
      state.tool = null;
      return true;
    default:
      return false;
  }
}

function applyNotification(state: ClaudeHookState, payload: Record<string, unknown>): boolean {
  const type = readString(payload, 'notification_type');
  const message = readString(payload, 'message');
  if (WAITING_NOTIFICATIONS.test(type) || (!type && /permission|needs your/i.test(message))) {
    state.lead = 'waiting';
    return true;
  }
  if (type === 'idle_prompt' || (!type && /waiting for .*input|ready for your input/i.test(message))) {
    state.lead = 'idle';
    return true;
  }
  return false;
}

/**
 * リードの Stop に載る background_tasks を roster に畳み込む。
 *
 * **リードの Stop でのみ呼ぶこと**。SubagentStop に載る同じ配列は古く、たった今
 * 停止した当人が running のまま載っている (実測)。そこで畳み込むと子が復活する。
 *
 * 完了ゲートに使うのは type が 'subagent' の要素だけ。teammate は Orca の観測では
 * 恒久的に running を報告し、非エージェントのバックグラウンドタスク
 * (run_in_background の dev サーバー等) は終わらないのが正常なので、どちらも
 * busy を固着させてしまう。表示用のフラグにとどめてゲートには入れない。
 */
function foldBackgroundTasks(state: ClaudeHookState, payload: Record<string, unknown>): void {
  const raw = payload.background_tasks;
  if (!Array.isArray(raw)) return; // フィールドが無い版では roster をそのまま保つ

  const listed = new Set<string>();
  let otherRunning = false;

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const task = item as Record<string, unknown>;
    const type = readString(task, 'type').toLowerCase();
    const status = readString(task, 'status').toLowerCase();
    const running = status.length === 0 || !TERMINAL_TASK_STATUSES.has(status);
    if (type !== 'subagent') {
      otherRunning ||= running;
      continue;
    }
    const id = readString(task, 'id');
    if (!id) continue;
    listed.add(id);
    if (!running) {
      state.subagents.delete(id);
      continue;
    }
    const tracked = state.subagents.get(id);
    upsertSubagent(
      state,
      id,
      { name: readString(task, 'agent_type'), description: readString(task, 'description') },
      // 未知の id は「この Stop より前から走っていた」ので開始時刻を偽らない。
      tracked ? tracked.startedAt : state.lastEventAt,
    );
  }

  // 載っていない subagent 行は終了済み (SubagentStop を取りこぼしても回収できる)。
  for (const id of [...state.subagents.keys()]) {
    if (!listed.has(id)) state.subagents.delete(id);
  }
  state.runningBackgroundTask = otherRunning;
}

function upsertSubagent(
  state: ClaudeHookState,
  id: string,
  fields: { name?: string; description?: string; activity?: string },
  startedAt: number,
): boolean {
  const existing = state.subagents.get(id);
  if (existing) {
    if (fields.name) existing.name = cap(fields.name);
    if (fields.description) existing.description = cap(fields.description);
    if (fields.activity !== undefined) existing.activity = cap(fields.activity);
    existing.state = 'working';
    return true;
  }
  if (state.subagents.size >= MAX_SUBAGENTS) return false;
  state.subagents.set(id, {
    id,
    name: cap(fields.name || 'Agent'),
    description: cap(fields.description || ''),
    startedAt,
    activity: cap(fields.activity || ''),
    state: 'working',
  });
  return true;
}

/** working な子が 1 つでもあるか。idle な子は完了ゲートを持たない。 */
export function hasWorkingSubagent(state: ClaudeHookState): boolean {
  for (const sub of state.subagents.values()) {
    if (sub.state === 'working') return true;
  }
  return false;
}

/** state から外向きステータスを導く。 */
export function deriveStatus(state: ClaudeHookState): AgentStatus | null {
  if (state.lead === 'waiting') return 'waiting'; // 人の対応待ちは何より優先
  if (hasWorkingSubagent(state)) return 'busy'; // リードが Stop していても子が居れば実行中
  if (state.lead === 'working') return 'busy';
  if (state.lead === 'idle') return 'idle';
  return null;
}

/** サブエージェントを表示順 (開始が早い順) で返す。 */
export function subagentList(state: ClaudeHookState): HookSubagent[] {
  return [...state.subagents.values()].sort(
    (a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** hook が途絶えたセッションを busy のまま固着させないための回収。 */
export function clearWork(state: ClaudeHookState): void {
  state.subagents.clear();
  state.runningBackgroundTask = false;
  state.tool = null;
  state.lead = 'idle';
}

function resetState(state: ClaudeHookState): void {
  state.lead = null;
  state.tool = null;
  state.subagents.clear();
  state.runningBackgroundTask = false;
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value : '';
}

function cap(value: string): string {
  return value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) : value;
}
