import fs from 'node:fs';
import os from 'node:os';
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
import { terminalEnv } from './childEnv.js';
import { writeJsonAtomic } from './config.js';
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
  | { kind: 'user'; text: string; images?: number; ts: number }
  | { kind: 'assistant'; text: string; ts: number }
  | { kind: 'command_output'; text: string; ts: number }
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
const IMAGE_MAX_COUNT = 4;
const IMAGE_MAX_BASE64 = 7_000_000; // 1 枚あたり base64 で約 5MB 相当
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const PERSIST_DEBOUNCE_MS = 500;

// resume 用の永続化レコード (~/.claude-deck3/agent-sessions/<deckId>.json)。
// サーバー再起動でメモリー上のセッションが消えても、SDK 側の session_id と
// deck 側のトランスクリプトを保存しておけば query({resume}) で再開できる。
const SESSIONS_DIR = path.join(os.homedir(), '.claude-deck3', 'agent-sessions');

export interface AgentSessionRecord {
  deckId: string;
  sdkSessionId: string;
  cwd: string;
  title: string;
  savedAt: number;
  events: AgentChatEvent[];
}

function recordFile(deckId: string): string {
  // deckId は自前生成の UUID 断片のみ受け付ける (パス組み立てに使うため)
  if (!/^[0-9a-f-]{4,40}$/i.test(deckId)) throw new Error('不正なセッション ID です');
  return path.join(SESSIONS_DIR, `${deckId}.json`);
}

function loadRecord(deckId: string): AgentSessionRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(recordFile(deckId), 'utf8')) as AgentSessionRecord;
    if (typeof raw.sdkSessionId !== 'string' || typeof raw.cwd !== 'string') return null;
    return { ...raw, events: Array.isArray(raw.events) ? raw.events : [] };
  } catch {
    return null;
  }
}

/** 貼り付け画像の形状検証 (信頼できない WS 入力)。 */
function validImages(value: unknown): { mediaType: string; data: string }[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > IMAGE_MAX_COUNT) return undefined;
  const images: { mediaType: string; data: string }[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return undefined;
    const img = item as { mediaType?: unknown; data?: unknown };
    if (
      typeof img.mediaType !== 'string' ||
      !IMAGE_MEDIA_TYPES.has(img.mediaType) ||
      typeof img.data !== 'string' ||
      img.data.length === 0 ||
      img.data.length > IMAGE_MAX_BASE64 ||
      !/^[A-Za-z0-9+/=]+$/.test(img.data)
    ) {
      return undefined;
    }
    images.push({ mediaType: img.mediaType, data: img.data });
  }
  return images;
}

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

/**
 * AskUserQuestion の回答 (質問文 → 選択ラベル) の形状検証。信頼できない WS 入力
 * なので、プレーンオブジェクト・文字列のみ・件数と長さの上限を強制する。
 */
function validAnswers(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 8) return undefined;
  const answers: Record<string, string> = {};
  for (const [key, val] of entries) {
    if (typeof val !== 'string' || key.length > 500 || val.length > 4_000) return undefined;
    answers[key] = val;
  }
  return answers;
}

/** subagent 内の assistant メッセージから「今なにをしているか」の 1 行を作る。 */
function subagentActivity(content: unknown): string {
  if (!Array.isArray(content)) return '';
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i] as { type?: string; name?: string; input?: Record<string, unknown> };
    if (block?.type === 'tool_use' && typeof block.name === 'string') {
      const input = block.input ?? {};
      const detail = [input.command, input.file_path, input.pattern, input.query, input.url, input.description]
        .find((v) => typeof v === 'string' && v) as string | undefined;
      return detail ? `${block.name}: ${detail.slice(0, 60)}` : block.name;
    }
  }
  return '';
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
  meta: {
    model: string | null;
    permissionMode: string | null;
    effort: string | null;
    thinking: boolean;
  };
  /** コンテキスト使用量 (assistant メッセージの usage から実測) */
  stats: { contextTokens: number | null; contextWindow: number | null };
  /** 稼働中のサブエージェント (Task/Agent tool_use 単位) */
  subagents: Map<
    string,
    { id: string; name: string; description: string; startedAt: number; activity: string }
  >;
  /** スラッシュコマンド一覧 (supportedCommands / commands_changed で更新) */
  commands: { name: string; description: string; argumentHint: string }[];
  /** 選択可能なモデル一覧 (supportedModels で取得) */
  models: {
    value: string;
    resolvedModel?: string;
    displayName: string;
    description: string;
    supportsEffort?: boolean;
    supportedEffortLevels?: string[];
  }[];
  sockets: Set<WebSocket>;
  input: AsyncQueue<SDKUserMessage>;
  q: Query;
  pending: Map<string, PendingPermission>;
  exited: boolean;
  /** SDK 側の session id (init で捕捉)。resume の鍵。null の間は永続化しない */
  sdkSessionId: string | null;
  /** 明示 kill = 記録も破棄。サーバー都合の終了では立てない */
  discard: boolean;
  persistTimer: NodeJS.Timeout | null;
}

export class AgentSessionManager {
  private sessions = new Map<string, AgentSession>();

  constructor() {
    registerSnapshotProvider(() => this.list());
    // 判定は実際に SDK へ渡す env (terminalEnv) で行う。process.env を見ると
    // deck の起動元にだけ設定された鍵を誤検知/見落としする。
    if (terminalEnv().ANTHROPIC_API_KEY) {
      console.warn(
        '[claude-deck3] 警告: ANTHROPIC_API_KEY が設定されています。' +
          'chat セッションはサブスクリプションではなく API キーで従量課金されます。',
      );
    }
  }

  create(cwd: string, resume?: AgentSessionRecord): SessionInfo {
    const id = randomUUID().slice(0, 8);
    const input = new AsyncQueue<SDKUserMessage>();
    const q = query({
      prompt: input,
      options: {
        cwd: path.resolve(cwd),
        includePartialMessages: true,
        // env を指定するとサブプロセスの環境は「マージではなく完全置換」になる (SDK 仕様)。
        // terminalEnv() は env のフルセットを返すのでそのまま渡してよい。deck の
        // 起動元シェル由来の汚染 (NODE_ENV=production 等) を claude に持ち込まないため。
        env: terminalEnv(),
        // settingSources は未指定 = CLI と同じ (user/project/local を読む)。
        ...(resume ? { resume: resume.sdkSessionId } : {}),
        canUseTool: (toolName, toolInput, options) =>
          this.requestPermission(id, toolName, toolInput, options),
      },
    });
    const session: AgentSession = {
      id,
      cwd: path.resolve(cwd),
      // ブランディング規約により「Claude Code」は名乗らない (SDK ベースの独自 UI のため)
      title: resume?.title ?? 'Claude Agent',
      status: 'idle',
      createdAt: Date.now(),
      lastOutputAt: Date.now(),
      statusSince: Date.now(),
      // resume 時は保存済みトランスクリプトを引き継いで表示を復元する
      events: resume ? [...resume.events] : [],
      live: { text: '', thinking: '' },
      meta: { model: null, permissionMode: null, effort: null, thinking: true },
      stats: { contextTokens: null, contextWindow: null },
      subagents: new Map(),
      commands: [],
      models: [],
      sockets: new Set(),
      input,
      q,
      pending: new Map(),
      exited: false,
      sdkSessionId: resume?.sdkSessionId ?? null,
      discard: false,
      persistTimer: null,
    };
    if (resume) {
      // 旧レコードは新しい deckId で保存し直すため破棄する
      try {
        fs.unlinkSync(recordFile(resume.deckId));
      } catch {
        // 既に無ければそれでよい
      }
      this.schedulePersist(session);
    }
    this.sessions.set(id, session);
    void this.pump(session);
    // CLI は最初の入力メッセージまで起動を遅延するため、init を待たず
    // ここで control request を投げてコマンド/モデル一覧を先に取りに行く
    // (副次効果として CLI が先に温まり、初回ターンの体感も速くなる)
    void this.loadCommands(session);
    void this.loadModels(session);
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
        stats: session.stats,
        subagents: [...session.subagents.values()],
        commands: session.commands,
        models: session.models,
        status: session.status,
        requests: [...session.pending.values()].map((p) => this.requestPayload(p)),
      }),
    );
    ws.on('message', (raw) => {
      // 信頼できない入力: JSON 形状と各フィールドの型を検証してから使う
      let msg: {
        type?: unknown;
        text?: unknown;
        requestId?: unknown;
        decision?: unknown;
        mode?: unknown;
        answers?: unknown;
        images?: unknown;
        model?: unknown;
        effort?: unknown;
        enabled?: unknown;
      };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (session.exited) return;
      const images = validImages(msg.images);
      if (msg.type === 'prompt' && typeof msg.text === 'string' && (msg.text.trim() || images)) {
        this.prompt(session, msg.text, images);
      } else if (
        msg.type === 'permission' &&
        typeof msg.requestId === 'string' &&
        (msg.decision === 'allow' || msg.decision === 'always' || msg.decision === 'deny')
      ) {
        // mode はプラン承認 (ExitPlanMode) 専用、answers は AskUserQuestion 専用の追加指定
        const postMode =
          msg.mode === 'acceptEdits' || msg.mode === 'auto' ? msg.mode : undefined;
        this.resolvePermission(session, msg.requestId, msg.decision, postMode, validAnswers(msg.answers));
      } else if (msg.type === 'setMode' && UI_MODES.has(msg.mode as PermissionMode)) {
        this.setMode(session, msg.mode as PermissionMode);
      } else if (msg.type === 'setModel' && typeof msg.model === 'string') {
        this.setModel(session, msg.model);
      } else if (
        msg.type === 'setEffort' &&
        (msg.effort === 'low' || msg.effort === 'medium' || msg.effort === 'high' ||
          msg.effort === 'xhigh' || msg.effort === 'max')
      ) {
        this.setEffort(session, msg.effort);
      } else if (msg.type === 'setThinking' && typeof msg.enabled === 'boolean') {
        this.setThinking(session, msg.enabled);
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
    // タブを閉じる = ユーザーの明示破棄。resume 用の記録も消す
    session.discard = true;
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

  /** 再開できる保存済みセッション (稼働中のものは除く)。 */
  resumable(cwd?: string): { deckId: string; title: string; cwd: string; savedAt: number }[] {
    let files: string[] = [];
    try {
      files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    const liveSdkIds = new Set(
      [...this.sessions.values()].map((s) => s.sdkSessionId).filter(Boolean),
    );
    const target = cwd ? normalizePath(cwd) : null;
    const records: { deckId: string; title: string; cwd: string; savedAt: number }[] = [];
    for (const file of files) {
      const record = loadRecord(path.basename(file, '.json'));
      if (!record) continue;
      if (liveSdkIds.has(record.sdkSessionId)) continue;
      if (target && normalizePath(record.cwd) !== target) continue;
      records.push({
        deckId: record.deckId,
        title: record.title,
        cwd: record.cwd,
        savedAt: record.savedAt,
      });
    }
    return records.sort((a, b) => b.savedAt - a.savedAt);
  }

  /** 保存済みセッションを再開する。レコードが無ければ null。 */
  resume(deckId: string): SessionInfo | null {
    const record = loadRecord(deckId);
    if (!record) return null;
    return this.create(record.cwd, record);
  }

  /** 保存済みセッションの記録を破棄する。 */
  discardRecord(deckId: string): boolean {
    try {
      fs.unlinkSync(recordFile(deckId));
      return true;
    } catch {
      return false;
    }
  }

  private schedulePersist(session: AgentSession): void {
    if (!session.sdkSessionId || session.discard) return;
    if (session.persistTimer) return;
    session.persistTimer = setTimeout(() => {
      session.persistTimer = null;
      this.persistNow(session);
    }, PERSIST_DEBOUNCE_MS);
    session.persistTimer.unref();
  }

  private persistNow(session: AgentSession): void {
    if (!session.sdkSessionId || session.discard) return;
    try {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      const record: AgentSessionRecord = {
        deckId: session.id,
        sdkSessionId: session.sdkSessionId,
        cwd: session.cwd,
        title: session.title,
        savedAt: Date.now(),
        events: session.events,
      };
      writeJsonAtomic(recordFile(session.id), record);
    } catch (err) {
      console.warn('[claude-deck3] agent session persist failed:', err);
    }
  }

  private setCommands(
    session: AgentSession,
    commands: { name: string; description: string; argumentHint: string }[],
  ): void {
    session.commands = commands.map((c) => ({
      name: c.name,
      description: c.description ?? '',
      argumentHint: c.argumentHint ?? '',
    }));
    this.broadcast(session, { type: 'commands', commands: session.commands });
  }

  private async loadCommands(session: AgentSession): Promise<void> {
    try {
      this.setCommands(session, await session.q.supportedCommands());
    } catch {
      // 未対応バージョン等。補完が出ないだけで動作には影響しない
    }
  }

  private async loadModels(session: AgentSession): Promise<void> {
    try {
      session.models = (await session.q.supportedModels()).map((m) => ({
        value: m.value,
        ...(m.resolvedModel ? { resolvedModel: m.resolvedModel } : {}),
        displayName: m.displayName,
        description: m.description ?? '',
        ...(m.supportsEffort ? { supportsEffort: true } : {}),
        ...(Array.isArray(m.supportedEffortLevels)
          ? { supportedEffortLevels: m.supportedEffortLevels }
          : {}),
      }));
      this.broadcast(session, { type: 'models', models: session.models });
    } catch {
      // 未対応バージョン等。セレクターが出ないだけで動作には影響しない
    }
  }

  /** モデルを実行中に切り替える (/model 相当)。一覧に無い値は受け付けない。 */
  private setModel(session: AgentSession, model: string): void {
    if (!session.models.some((m) => m.value === model)) return;
    session.q
      .setModel(model)
      .then(() => {
        session.meta = { ...session.meta, model };
        this.broadcast(session, { type: 'meta', meta: session.meta });
      })
      .catch((err: unknown) => {
        console.warn('[claude-deck3] setModel failed:', err);
        this.broadcast(session, { type: 'meta', meta: session.meta });
      });
  }

  /** effort レベルを実行中に切り替える (/effort 相当)。 */
  private setEffort(session: AgentSession, effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'): void {
    session.q
      .applyFlagSettings({ effortLevel: effort })
      .then(() => {
        session.meta = { ...session.meta, effort };
        this.broadcast(session, { type: 'meta', meta: session.meta });
      })
      .catch((err: unknown) => {
        console.warn('[claude-deck3] setEffort failed:', err);
        this.broadcast(session, { type: 'meta', meta: session.meta });
      });
  }

  /** thinking の on/off (off = maxThinkingTokens 0、on = 既定に戻す)。 */
  private setThinking(session: AgentSession, enabled: boolean): void {
    session.q
      .setMaxThinkingTokens(enabled ? null : 0)
      .then(() => {
        session.meta = { ...session.meta, thinking: enabled };
        this.broadcast(session, { type: 'meta', meta: session.meta });
      })
      .catch((err: unknown) => {
        console.warn('[claude-deck3] setThinking failed:', err);
        this.broadcast(session, { type: 'meta', meta: session.meta });
      });
  }

  private broadcastSubagents(session: AgentSession): void {
    this.broadcast(session, { type: 'subagents', subagents: [...session.subagents.values()] });
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

  private prompt(
    session: AgentSession,
    text: string,
    images?: { mediaType: string; data: string }[],
  ): void {
    this.pushEvent(session, {
      kind: 'user',
      text,
      ...(images && images.length > 0 ? { images: images.length } : {}),
      ts: Date.now(),
    });
    this.setStatus(session, 'busy');
    // 画像は base64 の image content block として本文の前に並べる
    const content =
      images && images.length > 0
        ? [
            ...images.map((img) => ({
              type: 'image' as const,
              source: { type: 'base64' as const, media_type: img.mediaType, data: img.data },
            })),
            ...(text.trim() ? [{ type: 'text' as const, text }] : []),
          ]
        : text;
    session.input.push({
      type: 'user',
      message: { role: 'user', content },
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
    /** AskUserQuestion の回答 (質問文 → 選択ラベル)。updatedInput.answers に注入する */
    answers?: Record<string, string>,
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
        // AskUserQuestion は「permission component が回答を collect して
        // updatedInput.answers で返す」のが SDK の想定経路 (sdk-tools.d.ts)
        updatedInput:
          pending.tool === 'AskUserQuestion' && answers
            ? { ...pending.input, answers }
            : pending.input,
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
      if (session.persistTimer) {
        clearTimeout(session.persistTimer);
        session.persistTimer = null;
      }
      if (session.discard) {
        // 明示 kill: resume 記録も破棄
        try {
          fs.unlinkSync(recordFile(session.id));
        } catch {
          // 未作成なら何もしない
        }
      } else {
        // 予期しない終了 (エラー等): 記録を残して resume 可能にする
        this.persistNow(session);
      }
      this.broadcast(session, { type: 'exit' });
      for (const ws of session.sockets) ws.close();
      this.sessions.delete(session.id);
      broadcastEvent({ type: 'removed', id: session.id });
    }
  }

  private handleMessage(session: AgentSession, msg: SDKMessage): void {
    // subagent 内部のメッセージ (parent_tool_use_id あり) はトランスクリプトには
    // 流さないが、ステータスバーの「何をやっているか」表示のために活動だけ拾う
    if ('parent_tool_use_id' in msg && msg.parent_tool_use_id) {
      const sub = session.subagents.get(msg.parent_tool_use_id);
      if (sub && msg.type === 'assistant') {
        const activity = subagentActivity(msg.message.content);
        if (activity && activity !== sub.activity) {
          sub.activity = activity;
          this.broadcastSubagents(session);
        }
      }
      return;
    }
    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init') {
          session.meta = {
            ...session.meta,
            model: typeof msg.model === 'string' ? msg.model : null,
            permissionMode: typeof msg.permissionMode === 'string' ? msg.permissionMode : null,
          };
          if (typeof msg.session_id === 'string' && msg.session_id) {
            session.sdkSessionId = msg.session_id;
            this.schedulePersist(session);
          }
          this.broadcast(session, { type: 'meta', meta: session.meta });
          // コマンド一覧は init の名前配列より説明付きの supportedCommands() を使う
          void this.loadCommands(session);
        } else if (msg.subtype === 'commands_changed') {
          this.setCommands(session, msg.commands);
        } else if (msg.subtype === 'local_command_output') {
          // /usage 等のローカルコマンド出力はトランスクリプトへそのまま流す
          this.pushEvent(session, {
            kind: 'command_output',
            text: capText(msg.content),
            ts: Date.now(),
          });
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
        // 実際に応答したモデルで表示を受動同期する (alias 切替後の正規 id 反映)
        const responseModel = (msg.message as { model?: unknown }).model;
        if (typeof responseModel === 'string' && responseModel !== session.meta.model) {
          session.meta = { ...session.meta, model: responseModel };
          this.broadcast(session, { type: 'meta', meta: session.meta });
        }
        // コンテキスト使用量 = この API 呼び出しのプロンプト全量 + 出力
        const usage = (msg.message as {
          usage?: {
            input_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
            output_tokens?: number;
          };
        }).usage;
        if (usage) {
          const contextTokens =
            (usage.input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0) +
            (usage.output_tokens ?? 0);
          if (contextTokens > 0 && contextTokens !== session.stats.contextTokens) {
            session.stats = { ...session.stats, contextTokens };
            this.broadcast(session, { type: 'stats', stats: session.stats });
          }
        }
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
            // サブエージェント起動 (Task / Agent) をステータスバー用に登録する
            if (block.name === 'Task' || block.name === 'Agent') {
              const input = block.input as { description?: unknown; subagent_type?: unknown };
              session.subagents.set(block.id, {
                id: block.id,
                name: typeof input.subagent_type === 'string' && input.subagent_type
                  ? input.subagent_type
                  : block.name,
                description: typeof input.description === 'string' ? input.description : '',
                startedAt: Date.now(),
                activity: '',
              });
              this.broadcastSubagents(session);
            }
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
          if (session.subagents.delete(b.tool_use_id)) this.broadcastSubagents(session);
        }
        break;
      }
      case 'result': {
        // contextWindow は modelUsage (モデル別集計) から現在モデルの値を拾う
        const modelUsage = (msg as { modelUsage?: Record<string, { contextWindow?: number; canonicalModel?: string }> }).modelUsage;
        if (modelUsage) {
          const entries = Object.entries(modelUsage);
          const match =
            entries.find(([key, u]) => key === session.meta.model || u.canonicalModel === session.meta.model) ??
            entries[0];
          const window = match?.[1]?.contextWindow;
          if (typeof window === 'number' && window > 0 && window !== session.stats.contextWindow) {
            session.stats = { ...session.stats, contextWindow: window };
            this.broadcast(session, { type: 'stats', stats: session.stats });
          }
        }
        this.pushEvent(session, {
          kind: 'result',
          subtype: msg.subtype,
          costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : null,
          durationMs: typeof msg.duration_ms === 'number' ? msg.duration_ms : null,
          ts: Date.now(),
        });
        session.live = { text: '', thinking: '' };
        // ターン終了 = サブエージェントも全員終了している (tool_result 取りこぼしの保険)
        if (session.subagents.size > 0) {
          session.subagents.clear();
          this.broadcastSubagents(session);
        }
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
    this.schedulePersist(session);
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
