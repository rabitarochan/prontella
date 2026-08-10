import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  query,
  type PermissionMode,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type PermissionResult,
  type PermissionUpdate,
} from '@anthropic-ai/claude-agent-sdk';
import type { WebSocket } from 'ws';
import { normalizePath, type AgentStatus, type SessionInfo } from './pty.js';
import { broadcastEvent, registerSnapshotProvider } from './sessionEvents.js';

/**
 * Agent SDK ベースのセッション ('chat' タイルビューのバックエンド)。
 *
 * PTY セッションと違い Claude Code を TUI ではなくライブラリーとして起動し、
 * 構造化イベント (text/thinking delta, tool_use/tool_result, 許可要求) を
 * /ws/agent で中継する。クライアントは VS Code 拡張風のトランスクリプト UI
 * として描画する。認証は PTY と同じく利用者自身の `/login` (サブスク OAuth)
 * に委ねる — deck は資格情報に一切触れない。ANTHROPIC_API_KEY が環境にあると
 * SDK がそちらを優先し API 従量課金になるため起動時に警告する。
 *
 * ステータスは pty.ts の applyHookEvent と同じ状態機械へ SDK メッセージを
 * 直接写像する (正規表現ヒューリスティック不要):
 *   prompt 受信 → busy / canUseTool 発火 → waiting / result → idle / 終了 → 削除
 */

// クライアントへ replay する構造化イベント。client/src/types.ts と手動同期
// (共有型機構がないため)。
export type AgentChatEvent =
  | { kind: 'user'; text: string; ts: number }
  | { kind: 'assistant'; text: string; ts: number }
  | { kind: 'thinking'; text: string; ts: number }
  | { kind: 'tool_use'; id: string; tool: string; input: unknown; ts: number }
  | { kind: 'tool_result'; toolUseId: string; text: string; isError: boolean; ts: number }
  | { kind: 'permission'; tool: string; decision: 'allow' | 'always' | 'deny'; ts: number }
  | { kind: 'result'; subtype: string; costUsd: number | null; durationMs: number | null; ts: number }
  | { kind: 'error'; message: string; ts: number };

interface PendingPermission {
  requestId: string;
  tool: string;
  input: Record<string, unknown>;
  /** ブリッジが組み立てた許可プロンプト文 ("Claude wants to read foo.txt" 相当) */
  title: string | null;
  description: string | null;
  /** 「常に許可」を選んだとき updatedPermissions として返す提案 (サーバー内のみ保持) */
  suggestions: PermissionUpdate[];
  resolve: (result: PermissionResult) => void;
}

// UI から切替を許すモード。bypassPermissions / dontAsk は意図的に出さない
// (全ツール無確認実行は deck の許可ダイアログ前提と相性が悪く、誤操作リスクが大きい)
const UI_MODES = new Set<PermissionMode>(['default', 'acceptEdits', 'plan', 'auto']);

const MAX_EVENTS = 500; // transcript replay cap (PTY の MAX_SCROLLBACK に相当)
const INPUT_JSON_MAX = 16_384; // tool_use input を構造のままクライアントへ渡す上限
const RESULT_TEXT_MAX = 8_192; // tool_result テキストの上限

/** tool input を構造のまま返す。巨大なら文字列プレビューへ落とす。 */
function capInput(input: unknown): unknown {
  try {
    const json = JSON.stringify(input);
    if (json.length <= INPUT_JSON_MAX) return input;
    return { __truncated: true, preview: json.slice(0, 4_000) };
  } catch {
    return { __truncated: true, preview: String(input).slice(0, 4_000) };
  }
}

function capText(text: string): string {
  return text.length <= RESULT_TEXT_MAX ? text : text.slice(0, RESULT_TEXT_MAX) + '\n… (truncated)';
}

/** tool_result の content (string | blocks) からテキストを取り出す。 */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** streaming input モードの入力キュー: push した user メッセージを SDK が消費する。 */
class AsyncQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.buffer.push(item);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const item = this.buffer.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

interface AgentSession {
  id: string;
  cwd: string;
  title: string;
  status: AgentStatus;
  createdAt: number;
  lastOutputAt: number;
  statusSince: number;
  events: AgentChatEvent[];
  /** 進行中ターンの途中経過 (attach 時の snapshot 用)。assistant 確定 / result で消える */
  live: { text: string; thinking: string };
  /** system/init から得たセッションメタ (snapshot と 'meta' で配布) */
  meta: { model: string | null; permissionMode: string | null };
  sockets: Set<WebSocket>;
  input: AsyncQueue<SDKUserMessage>;
  q: Query;
  pending: Map<string, PendingPermission>;
  exited: boolean;
}

export class AgentSessionManager {
  private sessions = new Map<string, AgentSession>();

  constructor() {
    registerSnapshotProvider(() => this.list());
    if (process.env.ANTHROPIC_API_KEY) {
      console.warn(
        '[claude-deck3] 警告: ANTHROPIC_API_KEY が設定されています。' +
          'chat セッションはサブスクリプションではなく API キーで従量課金されます。',
      );
    }
  }

  create(cwd: string): SessionInfo {
    const id = randomUUID().slice(0, 8);
    const input = new AsyncQueue<SDKUserMessage>();
    const q = query({
      prompt: input,
      options: {
        cwd: path.resolve(cwd),
        includePartialMessages: true,
        // settingSources は未指定 = CLI と同じ (user/project/local を読む)。
        canUseTool: (toolName, toolInput, options) =>
          this.requestPermission(id, toolName, toolInput, options),
      },
    });
    const session: AgentSession = {
      id,
      cwd: path.resolve(cwd),
      // ブランディング規約により「Claude Code」は名乗らない (SDK ベースの独自 UI のため)
      title: 'Claude Agent',
      status: 'idle',
      createdAt: Date.now(),
      lastOutputAt: Date.now(),
      statusSince: Date.now(),
      events: [],
      live: { text: '', thinking: '' },
      meta: { model: null, permissionMode: null },
      sockets: new Set(),
      input,
      q,
      pending: new Map(),
      exited: false,
    };
    this.sessions.set(id, session);
    void this.pump(session);
    broadcastEvent({ type: 'session', session: this.toInfo(session) });
    return this.toInfo(session);
  }

  attach(id: string, ws: WebSocket): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.sockets.add(ws);
    ws.send(
      JSON.stringify({
        type: 'snapshot',
        events: session.events,
        live: session.live,
        meta: session.meta,
        status: session.status,
        requests: [...session.pending.values()].map((p) => this.requestPayload(p)),
      }),
    );
    ws.on('message', (raw) => {
      // 信頼できない入力: JSON 形状と各フィールドの型を検証してから使う
      let msg: { type?: unknown; text?: unknown; requestId?: unknown; decision?: unknown; mode?: unknown };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (session.exited) return;
      if (msg.type === 'prompt' && typeof msg.text === 'string' && msg.text.trim()) {
        this.prompt(session, msg.text);
      } else if (
        msg.type === 'permission' &&
        typeof msg.requestId === 'string' &&
        (msg.decision === 'allow' || msg.decision === 'always' || msg.decision === 'deny')
      ) {
        // mode はプラン承認 (ExitPlanMode) 専用の追加指定: 承認後に適用するモード
        const postMode =
          msg.mode === 'acceptEdits' || msg.mode === 'auto' ? msg.mode : undefined;
        this.resolvePermission(session, msg.requestId, msg.decision, postMode);
      } else if (msg.type === 'setMode' && UI_MODES.has(msg.mode as PermissionMode)) {
        this.setMode(session, msg.mode as PermissionMode);
      } else if (msg.type === 'interrupt') {
        session.q.interrupt().catch(() => {
          // interrupt はターン未実行時などに失敗しうる。無視してよい
        });
      }
    });
    ws.on('close', () => session.sockets.delete(ws));
    return true;
  }

  kill(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.input.close();
    try {
      session.q.close();
    } catch {
      // 二重 close などは無視
    }
    // 後始末 (sessions からの削除・broadcast) は pump の finally が行う
    return true;
  }

  list(cwd?: string): SessionInfo[] {
    const all = [...this.sessions.values()].map((s) => this.toInfo(s));
    if (!cwd) return all;
    const target = normalizePath(cwd);
    return all.filter((s) => normalizePath(s.cwd) === target);
  }

  /** permissionMode を実行中に切り替える (TUI の Shift+Tab 相当)。 */
  private setMode(session: AgentSession, mode: PermissionMode): void {
    session.q
      .setPermissionMode(mode)
      .then(() => {
        session.meta = { ...session.meta, permissionMode: mode };
        this.broadcast(session, { type: 'meta', meta: session.meta });
      })
      .catch((err: unknown) => {
        // 失敗時は meta を変えない (クライアント表示が実状態と乖離しないように)
        console.warn('[claude-deck3] setPermissionMode failed:', err);
        this.broadcast(session, { type: 'meta', meta: session.meta });
      });
  }

  private prompt(session: AgentSession, text: string): void {
    this.pushEvent(session, { kind: 'user', text, ts: Date.now() });
    this.setStatus(session, 'busy');
    session.input.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    } as SDKUserMessage);
  }

  private requestPayload(p: PendingPermission) {
    return {
      requestId: p.requestId,
      tool: p.tool,
      input: capInput(p.input),
      title: p.title,
      description: p.description,
      canAlways: p.suggestions.length > 0,
    };
  }

  private requestPermission(
    sessionId: string,
    tool: string,
    input: Record<string, unknown>,
    options: { suggestions?: PermissionUpdate[]; title?: string; description?: string },
  ): Promise<PermissionResult> {
    const session = this.sessions.get(sessionId);
    if (!session) return Promise.resolve({ behavior: 'deny', message: 'セッションが終了しています' });
    const requestId = randomUUID().slice(0, 8);
    return new Promise<PermissionResult>((resolve) => {
      const pending: PendingPermission = {
        requestId,
        tool,
        input,
        title: options.title ?? null,
        description: options.description ?? null,
        suggestions: options.suggestions ?? [],
        resolve,
      };
      session.pending.set(requestId, pending);
      this.setStatus(session, 'waiting');
      this.broadcast(session, { type: 'permission_request', ...this.requestPayload(pending) });
    });
  }

  private resolvePermission(
    session: AgentSession,
    requestId: string,
    decision: 'allow' | 'always' | 'deny',
    /** ExitPlanMode 承認時に適用するモード (「承認して編集を自動承認 / 自動モード」) */
    postMode?: 'acceptEdits' | 'auto',
  ): void {
    const pending = session.pending.get(requestId);
    if (!pending) return;
    session.pending.delete(requestId);
    this.pushEvent(session, { kind: 'permission', tool: pending.tool, decision, ts: Date.now() });
    if (session.pending.size === 0) this.setStatus(session, 'busy');
    const isPlanApproval = pending.tool === 'ExitPlanMode' && decision !== 'deny';
    if (decision === 'deny') {
      pending.resolve({ behavior: 'deny', message: 'ユーザーがダイアログで拒否しました' });
    } else {
      pending.resolve({
        behavior: 'allow',
        updatedInput: pending.input,
        // 「常に許可」= SDK が提案した permission 更新をそのまま適用する。
        // プラン承認でモード指定があれば setMode をこのセッション限定で積む
        ...(decision === 'always' && pending.suggestions.length > 0
          ? { updatedPermissions: pending.suggestions }
          : isPlanApproval && postMode
            ? {
                updatedPermissions: [
                  { type: 'setMode', mode: postMode, destination: 'session' } satisfies PermissionUpdate,
                ],
              }
            : {}),
      });
    }
    // ExitPlanMode の承認は plan モードを抜ける。表示の追従と、updatedPermissions が
    // 適用されないバージョン差への保険として setPermissionMode も直列で送る
    // (resolve 後の送信なので FIFO により plan 脱出処理の後に適用される)
    if (isPlanApproval) {
      if (postMode) {
        this.setMode(session, postMode);
      } else {
        const setModeSuggestion =
          decision === 'always'
            ? pending.suggestions.find(
                (s): s is Extract<PermissionUpdate, { type: 'setMode' }> => s.type === 'setMode',
              )
            : undefined;
        session.meta = { ...session.meta, permissionMode: setModeSuggestion?.mode ?? 'default' };
        this.broadcast(session, { type: 'meta', meta: session.meta });
      }
    }
  }

  /** SDK メッセージストリームを消費し、構造化イベントとステータスへ写像する。 */
  private async pump(session: AgentSession): Promise<void> {
    try {
      for await (const msg of session.q) {
        session.lastOutputAt = Date.now();
        this.handleMessage(session, msg);
      }
    } catch (err) {
      if (!session.exited) {
        this.pushEvent(session, {
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
          ts: Date.now(),
        });
      }
    } finally {
      session.exited = true;
      session.input.close();
      // 未応答の許可要求は deny で解放する (SDK 側の待ちを残さない)
      for (const pending of session.pending.values()) {
        pending.resolve({ behavior: 'deny', message: 'セッションが終了しました' });
      }
      session.pending.clear();
      this.broadcast(session, { type: 'exit' });
      for (const ws of session.sockets) ws.close();
      this.sessions.delete(session.id);
      broadcastEvent({ type: 'removed', id: session.id });
    }
  }

  private handleMessage(session: AgentSession, msg: SDKMessage): void {
    // subagent 内部のメッセージ (parent_tool_use_id あり) は流さない。
    // subagent の活動は Task の tool_use カードとしてだけ見える。
    if ('parent_tool_use_id' in msg && msg.parent_tool_use_id) return;
    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init') {
          session.meta = {
            model: typeof msg.model === 'string' ? msg.model : null,
            permissionMode: typeof msg.permissionMode === 'string' ? msg.permissionMode : null,
          };
          this.broadcast(session, { type: 'meta', meta: session.meta });
        }
        break;
      }
      case 'stream_event': {
        const event = msg.event as {
          type?: string;
          delta?: { type?: string; text?: string; thinking?: string };
        };
        if (event?.type !== 'content_block_delta') break;
        if (event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
          session.live.text += event.delta.text;
          this.broadcast(session, { type: 'delta', channel: 'text', text: event.delta.text });
        } else if (event.delta?.type === 'thinking_delta' && typeof event.delta.thinking === 'string') {
          session.live.thinking += event.delta.thinking;
          this.broadcast(session, { type: 'delta', channel: 'thinking', text: event.delta.thinking });
        }
        break;
      }
      case 'assistant': {
        for (const block of msg.message.content) {
          if (block.type === 'text') {
            this.pushEvent(session, { kind: 'assistant', text: block.text, ts: Date.now() });
          } else if (block.type === 'thinking') {
            this.pushEvent(session, { kind: 'thinking', text: capText(block.thinking), ts: Date.now() });
          } else if (block.type === 'tool_use') {
            this.pushEvent(session, {
              kind: 'tool_use',
              id: block.id,
              tool: block.name,
              input: capInput(block.input),
              ts: Date.now(),
            });
          }
        }
        session.live = { text: '', thinking: '' };
        break;
      }
      case 'user': {
        // 自前で 'user' イベントは prompt() が積むので、ここでは tool_result だけ拾う
        const content = (msg.message as { content?: unknown }).content;
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          const b = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
          if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
          this.pushEvent(session, {
            kind: 'tool_result',
            toolUseId: b.tool_use_id,
            text: capText(resultText(b.content)),
            isError: b.is_error === true,
            ts: Date.now(),
          });
        }
        break;
      }
      case 'result': {
        this.pushEvent(session, {
          kind: 'result',
          subtype: msg.subtype,
          costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : null,
          durationMs: typeof msg.duration_ms === 'number' ? msg.duration_ms : null,
          ts: Date.now(),
        });
        session.live = { text: '', thinking: '' };
        this.setStatus(session, 'idle');
        break;
      }
      default:
        break;
    }
  }

  private pushEvent(session: AgentSession, event: AgentChatEvent): void {
    session.events.push(event);
    if (session.events.length > MAX_EVENTS) {
      session.events.splice(0, session.events.length - MAX_EVENTS);
    }
    this.broadcast(session, { type: 'event', event });
  }

  private setStatus(session: AgentSession, status: AgentStatus): void {
    if (session.status === status) return;
    session.status = status;
    session.statusSince = Date.now();
    this.broadcast(session, { type: 'status', status });
    broadcastEvent({ type: 'session', session: this.toInfo(session) });
  }

  private broadcast(session: AgentSession, msg: object): void {
    const payload = JSON.stringify(msg);
    for (const ws of session.sockets) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }

  private toInfo(session: AgentSession): SessionInfo {
    return {
      id: session.id,
      cwd: session.cwd,
      title: session.title,
      kind: 'sdk',
      status: session.status,
      claudeDetected: true,
      createdAt: session.createdAt,
      lastOutputAt: session.lastOutputAt,
      statusSince: session.statusSince,
    };
  }
}
