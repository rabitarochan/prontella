import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Check } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { api } from '../api';
import { useT, type StringKey } from '../i18n';
import { highlightInto } from '../markdown/highlight';
import { renderMarkdownToFragment } from '../markdown/render';
import type {
  AgentChatEvent,
  AgentPermissionRequest,
  AgentSessionMeta,
  AgentSlashCommand,
  AgentStatus,
} from '../types';
import StatusBadge from './StatusBadge';

// TUI の Shift+Tab 巡回と同じ並び。bypassPermissions / dontAsk は UI に出さない
// (server/agentSession.ts の UI_MODES と手動同期)
const MODES = ['default', 'acceptEdits', 'plan', 'auto'] as const;
type UiMode = (typeof MODES)[number];
const MODE_LABEL_KEY: Record<UiMode, StringKey> = {
  default: 'chat.modeManual',
  acceptEdits: 'chat.modeAcceptEdits',
  plan: 'chat.modePlan',
  auto: 'chat.modeAuto',
};

/**
 * chat (Agent SDK) セッション 1 つ分のビュー。/ws/agent?id= に接続し、
 * 構造化イベント (server/agentSession.ts) を VS Code 拡張風の全幅
 * トランスクリプトとして描画する: markdown 本文・tool_use/tool_result の
 * 折りたたみカード・Edit の diff・TodoWrite のチェックリスト・
 * TUI 相当の許可ダイアログ (許可 / 常に許可 / 拒否)。
 * XTermView と同型: display で隠れてもマウントされたまま接続を維持する。
 *
 * WS プロトコル (server/agentSession.ts と手動同期):
 *   受信: snapshot / event / delta {channel} / status / meta / permission_request / exit / error
 *   送信: prompt {text} / permission {requestId, decision} / interrupt
 */

// ---- 描画部品 (モジュールトップレベルで定義する — 親の再レンダーで identity が
// 変わると subtree が remount される。pj-client-ui-state §1) ----

/** assistant 本文の markdown 描画。renderMarkdownToFragment がセキュリティ境界。 */
function MarkdownBlock({ source, root }: { source: string; root: string }) {
  const mount = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return;
      const fragment = renderMarkdownToFragment(source, {
        mdPath: 'chat.md',
        root,
        allowExternalImages: false,
      });
      node.replaceChildren(fragment);
      for (const codeEl of node.querySelectorAll<HTMLElement>('code[data-lang]')) {
        void highlightInto(codeEl, codeEl.textContent ?? '', codeEl.dataset.lang ?? '');
      }
    },
    [source, root],
  );
  // render.ts の <a> は例外なく href="#"。素通りさせると SPA ごとリロードされる
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement).closest('a');
    if (!anchor || !e.currentTarget.contains(anchor)) return;
    e.preventDefault();
    const url = anchor.getAttribute('data-deck-external');
    if (url !== null) window.open(url, '_blank', 'noopener,noreferrer');
  };
  return <div className="md-preview-body chat-md" ref={mount} onClick={onClick} />;
}

function UserBlock({ text }: { text: string }) {
  return (
    <div className="chat-user">
      <span className="chat-user-mark">❯</span>
      <div className="chat-user-text">{text}</div>
    </div>
  );
}

function ThinkingBlock({ text, label }: { text: string; label: string }) {
  return (
    <details className="chat-thinking">
      <summary>✻ {label}</summary>
      <div className="chat-thinking-text">{text}</div>
    </details>
  );
}

interface TodoItem {
  content?: string;
  status?: string;
}

function TodoCard({ todos, label }: { todos: TodoItem[]; label: string }) {
  return (
    <div className="chat-todo">
      <div className="chat-todo-title">{label}</div>
      {todos.map((todo, i) => (
        <div key={i} className={`chat-todo-item ${todo.status ?? ''}`}>
          <span className="chat-todo-mark">
            {todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '▸' : '○'}
          </span>
          {todo.content ?? ''}
        </div>
      ))}
    </div>
  );
}

/** Edit / MultiEdit の old/new を TUI 風の -/+ 行で表示する。 */
function EditDiff({ oldText, newText }: { oldText: string; newText: string }) {
  return (
    <pre className="chat-diff">
      {oldText
        .split('\n')
        .map((line, i) => (
          <span key={`o${i}`} className="chat-diff-del">{`- ${line}\n`}</span>
        ))}
      {newText
        .split('\n')
        .map((line, i) => (
          <span key={`n${i}`} className="chat-diff-add">{`+ ${line}\n`}</span>
        ))}
    </pre>
  );
}

type ToolInput = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// ---- 入力補完 (スラッシュコマンド / @ファイルメンション) ----

interface CompletionItem {
  /** 置換対象トークン (draft 末尾のこの文字列を insert で置き換える) */
  token: string;
  insert: string;
  label: string;
  detail: string;
}

const COMPLETION_MAX = 8;

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

/** Ctrl+P と同系の軽量マッチ: 部分一致を優先し、残りをサブシーケンスで拾う。 */
function matchFiles(files: string[], query: string): string[] {
  if (!query) return files.slice(0, COMPLETION_MAX);
  const q = query.toLowerCase();
  const contains: string[] = [];
  const subseq: string[] = [];
  for (const file of files) {
    const f = file.toLowerCase();
    if (f.includes(q)) {
      contains.push(file);
      if (contains.length >= COMPLETION_MAX) break;
    } else if (subseq.length < COMPLETION_MAX && isSubsequence(q, f)) {
      subseq.push(file);
    }
  }
  return [...contains, ...subseq].slice(0, COMPLETION_MAX);
}

/**
 * draft の末尾トークンから補完候補を組み立てる。
 * - 入力全体が "/..." の 1 トークン → スラッシュコマンド補完
 * - 末尾トークンが "@..." → ファイルメンション補完
 */
function buildCompletion(
  draft: string,
  commands: AgentSlashCommand[],
  files: string[] | null,
): { kind: 'slash' | 'file'; items: CompletionItem[] } | null {
  if (/^\/\S*$/.test(draft)) {
    const q = draft.slice(1).toLowerCase();
    const items = commands
      .filter((c) => c.name.toLowerCase().includes(q))
      .slice(0, COMPLETION_MAX)
      .map((c) => ({
        token: draft,
        insert: `/${c.name} `,
        label: `/${c.name}`,
        detail: [c.argumentHint, c.description].filter(Boolean).join(' — '),
      }));
    return items.length > 0 ? { kind: 'slash', items } : null;
  }
  const mention = draft.match(/(?:^|\s)(@[^\s@]*)$/);
  if (mention && files) {
    const token = mention[1];
    const items = matchFiles(files, token.slice(1)).map((file) => ({
      token,
      insert: `@${file} `,
      label: file,
      detail: '',
    }));
    return items.length > 0 ? { kind: 'file', items } : null;
  }
  return null;
}

// ---- AskUserQuestion (質問カード) ----

interface QuestionOption {
  label: string;
  description?: string;
}
interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

/** AskUserQuestion の入力 (信頼できない構造) を防御的にパースする。 */
function parseQuestions(input: ToolInput): Question[] {
  if (!Array.isArray(input.questions)) return [];
  return (input.questions as unknown[]).flatMap((raw): Question[] => {
    if (!raw || typeof raw !== 'object') return [];
    const q = raw as { question?: unknown; header?: unknown; options?: unknown; multiSelect?: unknown };
    if (typeof q.question !== 'string' || !Array.isArray(q.options)) return [];
    const options = (q.options as unknown[]).flatMap((o): QuestionOption[] => {
      if (!o || typeof o !== 'object') return [];
      const opt = o as { label?: unknown; description?: unknown };
      if (typeof opt.label !== 'string') return [];
      return [{ label: opt.label, description: typeof opt.description === 'string' ? opt.description : undefined }];
    });
    if (options.length === 0) return [];
    return [
      {
        question: q.question,
        header: typeof q.header === 'string' ? q.header : undefined,
        options,
        multiSelect: q.multiSelect === true,
      },
    ];
  });
}

/**
 * AskUserQuestion の回答 UI。選択肢ボタン (multiSelect はトグル) + 自由入力。
 * 回答は「質問文 → ラベル (複数はカンマ区切り)」で親へ返す (SDK の
 * AskUserQuestionInput.answers の契約)。
 */
function QuestionCard({
  req,
  submitLabel,
  skipLabel,
  otherPlaceholder,
  onSubmit,
  onSkip,
}: {
  req: AgentPermissionRequest;
  submitLabel: string;
  skipLabel: string;
  otherPlaceholder: string;
  onSubmit: (answers: Record<string, string>) => void;
  onSkip: () => void;
}) {
  const questions = useMemo(() => parseQuestions((req.input ?? {}) as ToolInput), [req]);
  const [selected, setSelected] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});

  const toggle = (qi: number, label: string, multi: boolean) => {
    setSelected((prev) => {
      const cur = prev[qi] ?? [];
      if (multi) {
        return { ...prev, [qi]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] };
      }
      return { ...prev, [qi]: cur.includes(label) ? [] : [label] };
    });
  };

  const answered = questions.every(
    (_, i) => (selected[i]?.length ?? 0) > 0 || (other[i] ?? '').trim() !== '',
  );

  const submit = () => {
    const answers: Record<string, string> = {};
    questions.forEach((q, i) => {
      const parts = [...(selected[i] ?? [])];
      const free = (other[i] ?? '').trim();
      if (free) parts.push(free);
      answers[q.question] = parts.join(', ');
    });
    onSubmit(answers);
  };

  if (questions.length === 0) {
    // 想定外の形状: 生 JSON を出して手動判断してもらう
    return <pre className="chat-tool-pre">{JSON.stringify(req.input, null, 2)}</pre>;
  }

  return (
    <>
      {questions.map((q, qi) => (
        <div key={qi} className="chat-q">
          <div className="chat-q-head">
            {q.header && <span className="chat-q-chip">{q.header}</span>}
            <span className="chat-q-text">{q.question}</span>
          </div>
          <div className="chat-q-opts">
            {q.options.map((opt) => (
              <button
                key={opt.label}
                className={`chat-q-opt ${(selected[qi] ?? []).includes(opt.label) ? 'selected' : ''}`}
                onClick={() => toggle(qi, opt.label, q.multiSelect)}
              >
                <span className="chat-q-opt-label">{opt.label}</span>
                {opt.description && <span className="chat-q-opt-desc">{opt.description}</span>}
              </button>
            ))}
          </div>
          <input
            className="chat-q-other"
            type="text"
            placeholder={otherPlaceholder}
            value={other[qi] ?? ''}
            onChange={(e) => setOther((prev) => ({ ...prev, [qi]: e.target.value }))}
          />
        </div>
      ))}
      <div className="chat-perm-actions">
        <button className="chat-perm-allow" disabled={!answered} onClick={submit}>
          {submitLabel}
        </button>
        <button className="chat-perm-deny" onClick={onSkip}>
          {skipLabel}
        </button>
      </div>
    </>
  );
}

/** ツール呼び出しの 1 行サマリー (VS Code 拡張の "⏺ Bash(ls -la)" 相当)。 */
function toolSummary(tool: string, input: ToolInput): string {
  switch (tool) {
    case 'Bash':
      return str(input.command) || str(input.description);
    case 'ExitPlanMode':
      return str(input.plan).split('\n')[0] ?? '';
    case 'AskUserQuestion': {
      const first = Array.isArray(input.questions) ? (input.questions[0] as { question?: unknown }) : null;
      return str(first?.question);
    }
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return str(input.file_path);
    case 'Glob':
    case 'Grep':
      return str(input.pattern);
    case 'WebFetch':
    case 'WebSearch':
      return str(input.url) || str(input.query);
    case 'Task':
      return str(input.description);
    case 'Skill':
      return str(input.skill);
    default: {
      try {
        const json = JSON.stringify(input);
        return json === '{}' ? '' : json;
      } catch {
        return '';
      }
    }
  }
}

/** ツール入力の詳細 (details 展開時の本体)。ツールごとに最適な表現を選ぶ。 */
function ToolInputDetail({ tool, input }: { tool: string; input: ToolInput }) {
  if (tool === 'Edit') {
    return <EditDiff oldText={str(input.old_string)} newText={str(input.new_string)} />;
  }
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    return (
      <>
        {(input.edits as ToolInput[]).map((edit, i) => (
          <EditDiff key={i} oldText={str(edit.old_string)} newText={str(edit.new_string)} />
        ))}
      </>
    );
  }
  if (tool === 'Write') {
    return <pre className="chat-tool-pre">{str(input.content)}</pre>;
  }
  if (tool === 'Bash') {
    return <pre className="chat-tool-pre">{str(input.command)}</pre>;
  }
  if (tool === 'Task') {
    return <pre className="chat-tool-pre">{str(input.prompt)}</pre>;
  }
  if (tool === 'ExitPlanMode') {
    return <pre className="chat-tool-pre">{str(input.plan)}</pre>;
  }
  let json = '';
  try {
    json = JSON.stringify(input, null, 2);
  } catch {
    json = String(input);
  }
  return <pre className="chat-tool-pre">{json}</pre>;
}

function ToolCard({
  event,
  result,
  todoLabel,
  runningLabel,
}: {
  event: Extract<AgentChatEvent, { kind: 'tool_use' }>;
  result: Extract<AgentChatEvent, { kind: 'tool_result' }> | null;
  todoLabel: string;
  runningLabel: string;
}) {
  const input = (event.input ?? {}) as ToolInput;
  // TodoWrite は折りたたまず常時チェックリスト表示 (VS Code 拡張と同じ)
  if (event.tool === 'TodoWrite' && Array.isArray(input.todos)) {
    return <TodoCard todos={input.todos as TodoItem[]} label={todoLabel} />;
  }
  const summary = toolSummary(event.tool, input);
  const state = result ? (result.isError ? 'error' : 'done') : 'running';
  return (
    <details className={`chat-tool ${state}`}>
      <summary>
        <span className="chat-tool-bullet">⏺</span>
        <span className="chat-tool-name">{event.tool}</span>
        {summary && <span className="chat-tool-summary">{summary}</span>}
        <span className="chat-tool-state">
          {state === 'running' ? runningLabel : state === 'error' ? '✗' : '✓'}
        </span>
      </summary>
      <div className="chat-tool-detail">
        <ToolInputDetail tool={event.tool} input={input} />
        {result && result.text && (
          <pre className={`chat-tool-pre chat-tool-result ${result.isError ? 'error' : ''}`}>
            {result.text}
          </pre>
        )}
      </div>
    </details>
  );
}

export default function ChatView({
  id,
  root,
  visible,
}: {
  id: string;
  /** ワークツリー絶対パス。markdown の相対リンク解決コンテキストに使う。 */
  root: string;
  visible: boolean;
}) {
  const t = useT();
  const [events, setEvents] = useState<AgentChatEvent[]>([]);
  const [live, setLive] = useState({ text: '', thinking: '' });
  const [meta, setMeta] = useState<AgentSessionMeta>({ model: null, permissionMode: null });
  const [status, setStatus] = useState<AgentStatus>('idle');
  const [requests, setRequests] = useState<AgentPermissionRequest[]>([]);
  const [ended, setEnded] = useState(false);
  const [draft, setDraft] = useState('');
  const [commands, setCommands] = useState<AgentSlashCommand[]>([]);
  // ファイル一覧は '@' が初めて入力されたときに 1 回だけ取得する
  const [files, setFiles] = useState<string[] | null>(null);
  const filesLoadingRef = useRef(false);
  const [completeIndex, setCompleteIndex] = useState(0);
  // Esc で閉じたら同じ draft のままでは再表示しない (draft 変更で解除)
  const [completionDismissed, setCompletionDismissed] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // 末尾に張り付いているときだけ自動スクロールする (履歴を遡り中は動かさない)
  const stickRef = useRef(true);

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/agent?id=${id}`);
    wsRef.current = ws;
    ws.onmessage = (e) => {
      let msg: {
        type?: string;
        events?: AgentChatEvent[];
        event?: AgentChatEvent;
        live?: { text?: string; thinking?: string };
        meta?: AgentSessionMeta;
        channel?: string;
        text?: string;
        status?: AgentStatus;
        requests?: AgentPermissionRequest[];
        commands?: AgentSlashCommand[];
        requestId?: string;
        tool?: string;
        input?: unknown;
        title?: string | null;
        description?: string | null;
        canAlways?: boolean;
        message?: string;
      };
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      switch (msg.type) {
        case 'snapshot':
          setEvents(msg.events ?? []);
          setLive({ text: msg.live?.text ?? '', thinking: msg.live?.thinking ?? '' });
          if (msg.meta) setMeta(msg.meta);
          if (msg.status) setStatus(msg.status);
          setRequests(msg.requests ?? []);
          if (Array.isArray(msg.commands)) setCommands(msg.commands);
          break;
        case 'commands':
          if (Array.isArray(msg.commands)) setCommands(msg.commands);
          break;
        case 'event':
          if (msg.event) {
            const event = msg.event;
            setEvents((prev) => [...prev, event]);
            if (event.kind === 'assistant') setLive((prev) => ({ ...prev, text: '' }));
            if (event.kind === 'thinking') setLive((prev) => ({ ...prev, thinking: '' }));
            if (event.kind === 'result') setLive({ text: '', thinking: '' });
            // 別タブで応答された許可要求はイベント側から回収する
            if (event.kind === 'permission') {
              setRequests((prev) => {
                const idx = prev.findIndex((r) => r.tool === event.tool);
                return idx === -1 ? prev : prev.filter((_, i) => i !== idx);
              });
            }
          }
          break;
        case 'delta':
          if (typeof msg.text === 'string') {
            const text = msg.text;
            if (msg.channel === 'thinking') {
              setLive((prev) => ({ ...prev, thinking: prev.thinking + text }));
            } else {
              setLive((prev) => ({ ...prev, text: prev.text + text }));
            }
          }
          break;
        case 'meta':
          if (msg.meta) setMeta(msg.meta);
          break;
        case 'status':
          if (msg.status) setStatus(msg.status);
          break;
        case 'permission_request':
          if (typeof msg.requestId === 'string' && typeof msg.tool === 'string') {
            const req: AgentPermissionRequest = {
              requestId: msg.requestId,
              tool: msg.tool,
              input: msg.input ?? {},
              title: msg.title ?? null,
              description: msg.description ?? null,
              canAlways: msg.canAlways === true,
            };
            setRequests((prev) => [...prev, req]);
          }
          break;
        case 'exit':
          setEnded(true);
          break;
        case 'error':
          setEnded(true);
          if (typeof msg.message === 'string') {
            const errorEvent: AgentChatEvent = { kind: 'error', message: msg.message, ts: Date.now() };
            setEvents((prev) => [...prev, errorEvent]);
          }
          break;
        default:
          break;
      }
    };
    ws.onclose = () => {
      if (wsRef.current === ws) wsRef.current = null;
    };
    return () => {
      wsRef.current = null;
      ws.close();
    };
  }, [id]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [events, live, requests]);

  const send = (obj: object) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };

  const submit = () => {
    const text = draft.trim();
    if (!text || ended) return;
    stickRef.current = true;
    send({ type: 'prompt', text });
    setDraft('');
  };

  const answer = (
    requestId: string,
    decision: 'allow' | 'always' | 'deny',
    /** プラン承認 (ExitPlanMode) 専用: 承認後に適用するモード */
    mode?: 'acceptEdits' | 'auto',
    /** AskUserQuestion 専用: 質問文 → 回答ラベル */
    answers?: Record<string, string>,
  ) => {
    setRequests((prev) => prev.filter((r) => r.requestId !== requestId));
    send({
      type: 'permission',
      requestId,
      decision,
      ...(mode ? { mode } : {}),
      ...(answers ? { answers } : {}),
    });
  };

  // ---- 入力補完 ----
  const completion = useMemo(
    () => (completionDismissed ? null : buildCompletion(draft, commands, files)),
    [draft, commands, files, completionDismissed],
  );

  // '@' トークンが現れたらファイル一覧を遅延ロード (セッションごとに 1 回)
  useEffect(() => {
    if (files !== null || filesLoadingRef.current) return;
    if (!/(?:^|\s)@[^\s@]*$/.test(draft)) return;
    filesLoadingRef.current = true;
    api
      .searchFiles(root)
      .then((res) => setFiles(res.files))
      .catch(() => {
        filesLoadingRef.current = false; // 失敗時は次の '@' で再試行
      });
  }, [draft, files, root]);

  // 候補が変わったら選択位置を先頭へ戻す
  const completionSig = completion?.items.map((i) => i.label).join('\n') ?? '';
  useEffect(() => {
    setCompleteIndex(0);
  }, [completionSig]);

  const applyCompletion = (item: CompletionItem) => {
    setDraft((prev) =>
      prev.endsWith(item.token) ? prev.slice(0, prev.length - item.token.length) + item.insert : prev,
    );
  };

  const currentMode: UiMode = (MODES as readonly string[]).includes(meta.permissionMode ?? '')
    ? (meta.permissionMode as UiMode)
    : 'default';

  const setMode = (mode: UiMode) => {
    if (ended || mode === currentMode) return;
    send({ type: 'setMode', mode });
  };

  const cycleMode = () => {
    setMode(MODES[(MODES.indexOf(currentMode) + 1) % MODES.length]);
  };

  // tool_result は対応する tool_use カードの中に描く
  const resultByToolUse = useMemo(() => {
    const map = new Map<string, Extract<AgentChatEvent, { kind: 'tool_result' }>>();
    for (const event of events) {
      if (event.kind === 'tool_result') map.set(event.toolUseId, event);
    }
    return map;
  }, [events]);

  // セッション累計コスト (result の total_cost_usd は累計値なので最後の値を使う)
  const sessionCost = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.kind === 'result' && event.costUsd !== null) return event.costUsd;
    }
    return null;
  }, [events]);

  const modelLabel = meta.model?.replace(/^claude-/, '') ?? null;

  return (
    <div className="chat-view" style={{ display: visible ? undefined : 'none' }}>
      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {events.length === 0 && !live.text && !live.thinking && (
          <div className="chat-hint">{t('chat.startHint')}</div>
        )}
        {events.map((event, i) => {
          switch (event.kind) {
            case 'user':
              return <UserBlock key={i} text={event.text} />;
            case 'assistant':
              return <MarkdownBlock key={i} source={event.text} root={root} />;
            case 'command_output':
              return (
                <pre key={i} className="chat-cmd-output">
                  {event.text}
                </pre>
              );
            case 'thinking':
              return <ThinkingBlock key={i} text={event.text} label={t('chat.thinking')} />;
            case 'tool_use':
              return (
                <ToolCard
                  key={i}
                  event={event}
                  result={resultByToolUse.get(event.id) ?? null}
                  todoLabel={t('chat.todoTitle')}
                  runningLabel={t('chat.toolRunning')}
                />
              );
            case 'permission':
              return (
                <div key={i} className={`chat-perm-note ${event.decision}`}>
                  {event.decision === 'deny'
                    ? t('chat.permissionDenied', { tool: event.tool })
                    : t('chat.permissionAllowed', { tool: event.tool })}
                </div>
              );
            case 'result':
              return (
                <div key={i} className={`chat-turn-end ${event.subtype === 'success' ? '' : 'error'}`}>
                  {event.subtype !== 'success' && (
                    <span className="chat-turn-error">{t('chat.turnError', { subtype: event.subtype })}</span>
                  )}
                  <span className="chat-turn-stats">
                    {event.durationMs !== null && `${(event.durationMs / 1000).toFixed(1)}s`}
                  </span>
                </div>
              );
            case 'error':
              return (
                <div key={i} className="chat-error">
                  {event.message}
                </div>
              );
            default:
              return null;
          }
        })}
        {live.thinking && (
          <div className="chat-thinking-live">
            <span className="chat-thinking-mark">✻ {t('chat.thinking')}…</span>
            <div className="chat-thinking-text">{live.thinking}</div>
          </div>
        )}
        {live.text && <div className="chat-live">{live.text}</div>}
        {status === 'busy' && !live.text && !live.thinking && (
          <div className="chat-working">✻ {t('chat.working')}</div>
        )}
        {requests.map((req) => {
          // AskUserQuestion = 質問カード (許可ではなく回答を集める)
          if (req.tool === 'AskUserQuestion') {
            return (
              <div key={req.requestId} className="chat-perm-card chat-q-card">
                <div className="chat-perm-title">
                  <span className="codicon codicon-question" />
                  {t('chat.questionTitle')}
                </div>
                <QuestionCard
                  req={req}
                  submitLabel={t('chat.questionSubmit')}
                  skipLabel={t('chat.questionSkip')}
                  otherPlaceholder={t('chat.questionOtherPlaceholder')}
                  onSubmit={(answers) => answer(req.requestId, 'allow', undefined, answers)}
                  onSkip={() => answer(req.requestId, 'deny')}
                />
              </div>
            );
          }
          // ExitPlanMode = プラン承認 (TUI の plan mode 承認ダイアログ相当)。
          // プラン本文を markdown で描画し、選択肢の文言も専用にする
          const isPlan = req.tool === 'ExitPlanMode';
          return (
            <div key={req.requestId} className="chat-perm-card">
              <div className="chat-perm-title">
                <span className="codicon codicon-shield" />
                {isPlan ? t('chat.planTitle') : (req.title ?? t('chat.permissionTitle', { tool: req.tool }))}
              </div>
              {!isPlan && req.description && <div className="chat-perm-desc">{req.description}</div>}
              <div className="chat-perm-body">
                {isPlan ? (
                  <MarkdownBlock source={str(((req.input ?? {}) as ToolInput).plan)} root={root} />
                ) : (
                  <ToolInputDetail tool={req.tool} input={(req.input ?? {}) as ToolInput} />
                )}
              </div>
              <div className="chat-perm-actions">
                {isPlan ? (
                  <>
                    {/* TUI のプラン承認と同じ選択肢: 手動で続行 / 編集を自動承認 / 自動モード */}
                    <button className="chat-perm-allow" onClick={() => answer(req.requestId, 'allow')}>
                      {t('chat.planApprove')}
                    </button>
                    <button
                      className="chat-perm-always"
                      onClick={() => answer(req.requestId, 'allow', 'acceptEdits')}
                    >
                      {t('chat.planApproveAccept')}
                    </button>
                    <button
                      className="chat-perm-always"
                      onClick={() => answer(req.requestId, 'allow', 'auto')}
                    >
                      {t('chat.planApproveAuto')}
                    </button>
                    <button className="chat-perm-deny" onClick={() => answer(req.requestId, 'deny')}>
                      {t('chat.planKeep')}
                    </button>
                  </>
                ) : (
                  <>
                    <button className="chat-perm-allow" onClick={() => answer(req.requestId, 'allow')}>
                      {t('chat.allow')}
                    </button>
                    {req.canAlways && (
                      <button
                        className="chat-perm-always"
                        onClick={() => answer(req.requestId, 'always')}
                      >
                        {t('chat.alwaysAllow')}
                      </button>
                    )}
                    <button className="chat-perm-deny" onClick={() => answer(req.requestId, 'deny')}>
                      {t('chat.deny')}
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
        {ended && <div className="chat-ended">{t('chat.ended')}</div>}
      </div>
      <div className="chat-statusbar">
        <StatusBadge status={status} dot />
        {modelLabel && <span className="chat-statusbar-model">{modelLabel}</span>}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className={`chat-mode-btn ${currentMode !== 'default' ? 'active' : ''}`}
              title={t('chat.modeTooltip')}
              disabled={ended}
            >
              {t(MODE_LABEL_KEY[currentMode])}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" onCloseAutoFocus={(e) => e.preventDefault()}>
            {MODES.map((mode) => (
              <DropdownMenuItem key={mode} onSelect={() => setMode(mode)}>
                {t(MODE_LABEL_KEY[mode])}
                {mode === currentMode && <Check className="ml-auto text-primary" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="chat-statusbar-spacer" />
        {sessionCost !== null && (
          <span className="chat-statusbar-cost">${sessionCost.toFixed(2)}</span>
        )}
        {status === 'busy' && (
          <button
            className="chat-stop"
            title={t('chat.interrupt')}
            onClick={() => send({ type: 'interrupt' })}
          >
            <span className="codicon codicon-debug-stop" /> {t('chat.interrupt')}
          </button>
        )}
      </div>
      <div className="chat-input-row">
        {completion && (
          <div className="chat-complete">
            {completion.items.map((item, i) => (
              <button
                key={item.label}
                className={`chat-complete-item ${i === completeIndex ? 'active' : ''}`}
                // mousedown で textarea のフォーカスを奪わない
                onMouseDown={(e) => {
                  e.preventDefault();
                  applyCompletion(item);
                }}
              >
                <span className="chat-complete-label">{item.label}</span>
                {item.detail && <span className="chat-complete-detail">{item.detail}</span>}
              </button>
            ))}
          </div>
        )}
        <textarea
          className="chat-input"
          rows={2}
          placeholder={ended ? t('chat.ended') : t('chat.inputPlaceholder')}
          value={draft}
          disabled={ended}
          onChange={(e) => {
            setDraft(e.target.value);
            setCompletionDismissed(false);
          }}
          onKeyDown={(e) => {
            // 補完ポップアップが開いている間は Enter/Tab/矢印/Esc を補完操作に充てる
            if (completion) {
              const len = completion.items.length;
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setCompleteIndex((i) => (i + 1) % len);
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setCompleteIndex((i) => (i - 1 + len) % len);
                return;
              }
              if ((e.key === 'Tab' && !e.shiftKey) || (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing)) {
                e.preventDefault();
                applyCompletion(completion.items[completeIndex] ?? completion.items[0]);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setCompletionDismissed(true);
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            } else if (e.key === 'Tab' && e.shiftKey) {
              // TUI と同じ Shift+Tab でモード巡回
              e.preventDefault();
              cycleMode();
            } else if (e.key === 'Escape' && status === 'busy') {
              send({ type: 'interrupt' });
            }
          }}
        />
        <button
          className="chat-send"
          title={t('chat.send')}
          disabled={ended || !draft.trim()}
          onClick={submit}
        >
          <span className="codicon codicon-send" />
        </button>
      </div>
    </div>
  );
}
