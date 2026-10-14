import { create } from 'zustand';
import { getFilesTabs } from '../search/registry';
import { DebugRun, type AdapterId } from './session';

/**
 * デバッグ実行の状態 (root ごと) とブレークポイント (root ごと、localStorage に永続化)。
 *
 * - 純関数 (`reduceEvent` / `toggleLines` / `parseStoredBreakpoints` / `applyBreakpointResponse`) は vitest 対象。
 *   `.tsx` にロジックを置かない
 * - 実行そのもの (`DebugRun`) はシリアライズできないのでモジュール状態 (`runs`) に持ち、store には表示用の状態だけ
 * - 停止・出力は**子セッション**に来る (vscode-js-debug は root をランチャーにする。RESULTS.md D3)。
 *   「アクティブセッション」は最後に stopped を出したもの
 * - BP の検証状態は setBreakpoints 応答の**要求順**で対応付け、`breakpoint` changed イベントは id で引く。
 *   表示行はユーザーが置いた行 (要求行)、アダプターの実際の行は info.line に持つ
 */

export type RunPhase = 'idle' | 'starting' | 'running' | 'stopped' | 'terminated';

export interface Frame {
  id: number;
  name: string;
  /** root 相対。root 外 (node internals 等) は null = 開けない */
  path: string | null;
  line: number;
  column: number;
  sessionId: string;
  deemphasize: boolean;
}
export interface Scope {
  name: string;
  variablesReference: number;
  expensive?: boolean;
}
export interface Variable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
}
export interface ConsoleLine {
  category: string;
  text: string;
}
export interface BpInfo {
  id: number | null;
  verified: boolean;
  /** アダプターが実際に置いた行 */
  line: number;
}
export interface RunStatus {
  state: string;
  error?: string;
  source?: string;
}
export interface RunState {
  phase: RunPhase;
  status: RunStatus | null;
  sessions: string[];
  rootSession: string | null;
  activeSession: string | null;
  activeThread: number | null;
  stopReason: string | null;
  frames: Frame[];
  activeFrame: number | null;
  scopes: Scope[];
  variables: Record<number, Variable[]>;
  expanded: number[];
  console: ConsoleLine[];
  /** path → 要求行 → 検証状態 */
  verified: Record<string, Record<number, BpInfo>>;
  currentLine: { path: string; line: number } | null;
  error: string | null;
}

export type Breakpoints = Record<string, number[]>;

export const CONSOLE_MAX = 2000;
const STORAGE_PREFIX = 'prontella:debug:bps:';

export function emptyRun(): RunState {
  return {
    phase: 'idle', status: null, sessions: [], rootSession: null, activeSession: null, activeThread: null, stopReason: null,
    frames: [], activeFrame: null, scopes: [], variables: {}, expanded: [], console: [], verified: {}, currentLine: null, error: null,
  };
}

// ---- 純関数 --------------------------------------------------------------------

export function toggleLines(bps: Breakpoints, path: string, line: number): Breakpoints {
  const lines = bps[path] ?? [];
  const next = lines.includes(line) ? lines.filter((l) => l !== line) : [...lines, line].sort((a, b) => a - b);
  const out = { ...bps };
  if (next.length === 0) delete out[path];
  else out[path] = next;
  return out;
}

/** localStorage から読んだ値の防御的検証 (editorState.ts の sanitize と同じ流儀)。 */
export function parseStoredBreakpoints(raw: string | null): Breakpoints {
  if (!raw) return {};
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return {};
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Breakpoints = {};
  for (const [path, lines] of Object.entries(v as Record<string, unknown>)) {
    if (!path || path.startsWith('/') || path.includes('..') || !Array.isArray(lines)) continue;
    const ok = [...new Set(lines.filter((l): l is number => typeof l === 'number' && Number.isInteger(l) && l >= 1))].sort((a, b) => a - b);
    if (ok.length > 0) out[path] = ok;
  }
  return out;
}

interface BpResponseItem {
  id?: number;
  verified?: boolean;
  line?: number;
}

/** setBreakpoints 応答を要求順で対応付ける (id は重複することがある。RESULTS.md D4)。 */
export function applyBreakpointResponse(run: RunState, path: string, requested: number[], items: BpResponseItem[]): RunState {
  const infos: Record<number, BpInfo> = {};
  requested.forEach((line, i) => {
    const it = items[i];
    infos[line] = { id: typeof it?.id === 'number' ? it.id : null, verified: it?.verified === true, line: typeof it?.line === 'number' ? it.line : line };
  });
  return { ...run, verified: { ...run.verified, [path]: infos } };
}

export function reduceEvent(run: RunState, sessionId: string | null, event: string, body: unknown): RunState {
  const b = (body ?? {}) as Record<string, unknown>;
  switch (event) {
    case 'prontella/status': {
      const status: RunStatus = { state: String(b.state ?? ''), error: typeof b.error === 'string' ? b.error : undefined, source: typeof b.source === 'string' ? b.source : undefined };
      if (status.state === 'failed' || status.state === 'exited') {
        return { ...run, status, phase: 'terminated', error: status.error ?? run.error, currentLine: null, frames: [] };
      }
      return { ...run, status };
    }
    case 'prontella/session': {
      const id = String(b.sessionId ?? '');
      if (!id) return run;
      return { ...run, sessions: [...run.sessions, id], rootSession: b.parentSessionId === null ? id : run.rootSession, phase: run.phase === 'starting' || run.phase === 'idle' ? 'running' : run.phase };
    }
    case 'stopped':
      if (!sessionId) return run;
      return {
        ...run, phase: 'stopped', activeSession: sessionId, activeThread: typeof b.threadId === 'number' ? b.threadId : null,
        stopReason: typeof b.reason === 'string' ? b.reason : null, frames: [], activeFrame: null, scopes: [], variables: {}, expanded: [],
      };
    case 'continued':
      if (sessionId !== run.activeSession || run.phase !== 'stopped') return run;
      return { ...run, phase: 'running', frames: [], activeFrame: null, scopes: [], variables: {}, expanded: [], currentLine: null };
    case 'output': {
      const text = typeof b.output === 'string' ? b.output : '';
      if (!text) return run;
      const line: ConsoleLine = { category: typeof b.category === 'string' ? b.category : 'console', text };
      const next = run.console.length >= CONSOLE_MAX ? [...run.console.slice(run.console.length - CONSOLE_MAX + 1), line] : [...run.console, line];
      return { ...run, console: next };
    }
    case 'terminated':
    case 'exited': {
      if (!sessionId) return run;
      if (sessionId === run.rootSession) return { ...run, phase: 'terminated', currentLine: null, frames: [], activeFrame: null, scopes: [], sessions: [] };
      const sessions = run.sessions.filter((s) => s !== sessionId);
      if (sessions.length === run.sessions.length) return run;
      const wasActive = sessionId === run.activeSession;
      return { ...run, sessions, activeSession: wasActive ? null : run.activeSession, phase: wasActive && run.phase === 'stopped' ? 'running' : run.phase, currentLine: wasActive ? null : run.currentLine, frames: wasActive ? [] : run.frames };
    }
    case 'breakpoint': {
      const bp = (b.breakpoint ?? {}) as BpResponseItem & { source?: { path?: unknown } };
      if (typeof bp.id !== 'number') return run;
      const verified = { ...run.verified };
      let changed = false;
      for (const [path, infos] of Object.entries(verified)) {
        const next = { ...infos };
        for (const [reqLine, info] of Object.entries(infos)) {
          if (info.id !== bp.id) continue;
          next[Number(reqLine)] = { ...info, verified: bp.verified === true, line: typeof bp.line === 'number' ? bp.line : info.line };
          changed = true;
        }
        verified[path] = next;
      }
      return changed ? { ...run, verified } : run;
    }
    default:
      return run;
  }
}

// ---- store -----------------------------------------------------------------------

export interface StartChoice {
  /** launch.json の name。無ければ内蔵既定 (file が要る) */
  name?: string;
  /** root 相対の対象ファイル (内蔵既定 / `${file}`) */
  file?: string;
  request: 'launch' | 'attach';
  adapter: AdapterId;
}

interface DebugStoreState {
  runs: Record<string, RunState>;
  breakpoints: Record<string, Breakpoints>;
  ensureBreakpoints: (root: string) => Breakpoints;
  toggleBreakpoint: (root: string, path: string, line: number) => void;
  start: (root: string, choice: StartChoice) => void;
  stop: (root: string) => void;
  control: (root: string, command: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause') => void;
  selectFrame: (root: string, frameId: number) => void;
  toggleExpand: (root: string, ref: number) => void;
  evaluate: (root: string, expression: string) => void;
  clearConsole: (root: string) => void;
}

interface Live {
  run: DebugRun;
  choice: StartChoice;
}
const runs = new Map<string, Live>();
/** `${root}\0${sessionId}` → initialized イベント待ち。来ない (来る前に切断) ときは INITIALIZED_TIMEOUT_MS で進める */
const initializedWaiters = new Map<string, () => void>();
const INITIALIZED_TIMEOUT_MS = 10_000;

const initializeArgs = (adapter: AdapterId) => ({
  clientID: 'prontella', clientName: 'prontella', adapterID: adapter === 'csharp' ? 'coreclr' : 'node', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path',
  supportsRunInTerminalRequest: false, supportsStartDebuggingRequest: true, supportsVariableType: true,
});

function storageKey(root: string): string {
  return STORAGE_PREFIX + root;
}

function safeStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeStorageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // quota / private mode: 永続化できないだけで動作は続ける
  }
}

export const useDebugStore = create<DebugStoreState>((set, get) => {
  const update = (root: string, fn: (run: RunState) => RunState) =>
    set((s) => {
      const prev = s.runs[root] ?? emptyRun();
      const next = fn(prev);
      return next === prev ? s : { runs: { ...s.runs, [root]: next } };
    });
  const live = (root: string): Live | undefined => runs.get(root);

  /** 停止フレームの取得 → スコープ → エディターへ着地 */
  async function loadFrames(root: string, sessionId: string, threadId: number): Promise<void> {
    const l = live(root);
    if (!l) return;
    const r = await l.run.request<{ stackFrames?: Array<Record<string, unknown>> }>(sessionId, 'stackTrace', { threadId, startFrame: 0, levels: 50 });
    if (!r.success || live(root) !== l) return;
    const frames: Frame[] = (r.body?.stackFrames ?? []).map((f) => {
      const src = (f.source ?? null) as { path?: unknown } | null;
      return {
        id: Number(f.id), name: String(f.name ?? ''), path: typeof src?.path === 'string' ? src.path : null,
        line: Number(f.line ?? 0), column: Number(f.column ?? 0), sessionId, deemphasize: f.presentationHint === 'deemphasize' || f.presentationHint === 'label',
      };
    });
    const first = frames.find((f) => f.path !== null) ?? frames[0];
    update(root, (run) => (run.activeSession === sessionId && run.phase === 'stopped' ? { ...run, frames } : run));
    if (first) get().selectFrame(root, first.id);
  }

  async function loadScopes(root: string, frame: Frame): Promise<void> {
    const l = live(root);
    if (!l) return;
    const r = await l.run.request<{ scopes?: Scope[] }>(frame.sessionId, 'scopes', { frameId: frame.id });
    if (!r.success || live(root) !== l) return;
    update(root, (run) => (run.activeFrame === frame.id ? { ...run, scopes: r.body?.scopes ?? [] } : run));
  }

  async function loadVariables(root: string, sessionId: string, ref: number): Promise<void> {
    const l = live(root);
    if (!l) return;
    const r = await l.run.request<{ variables?: Variable[] }>(sessionId, 'variables', { variablesReference: ref });
    if (!r.success || live(root) !== l) return;
    update(root, (run) => ({ ...run, variables: { ...run.variables, [ref]: r.body?.variables ?? [] } }));
  }

  /** initialize → setBreakpoints (全ファイル) → configurationDone → launch/attach。root も子も同じ */
  async function startSession(root: string, sessionId: string, request: 'launch' | 'attach', args: unknown): Promise<void> {
    const l = live(root);
    if (!l) return;
    await l.run.request(sessionId, 'initialize', initializeArgs(l.choice.adapter));
    // VS Code と同じ順序: launch は先に送って応答を待たず、`initialized` → setBreakpoints → configurationDone の後に応答が来る。
    // netcoredbg は configurationDone を launch より先に受けると launch に応答しない (隔離 E2E で実測)。js-debug はどちらでも通る
    const launched = l.run.request(sessionId, request, args);
    await new Promise<void>((resolve) => {
      const key = `${root}\0${sessionId}`;
      const timer = setTimeout(() => (initializedWaiters.delete(key), resolve()), INITIALIZED_TIMEOUT_MS);
      initializedWaiters.set(key, () => (clearTimeout(timer), resolve()));
    });
    for (const [path, lines] of Object.entries(get().ensureBreakpoints(root))) await sendBreakpoints(root, sessionId, path, lines);
    await l.run.request(sessionId, 'configurationDone', {});
    const r = await launched;
    if (!r.success && live(root) === l) update(root, (run) => ({ ...run, error: r.message ?? `${request} に失敗しました` }));
  }

  async function sendBreakpoints(root: string, sessionId: string, path: string, lines: number[]): Promise<void> {
    const l = live(root);
    if (!l) return;
    const r = await l.run.request<{ breakpoints?: BpResponseItem[] }>(sessionId, 'setBreakpoints', { source: { path }, breakpoints: lines.map((line) => ({ line })) });
    if (!r.success || live(root) !== l) return;
    update(root, (run) => applyBreakpointResponse(run, path, lines, r.body?.breakpoints ?? []));
  }

  function revealFrame(root: string, frame: Frame): void {
    if (frame.path === null) return;
    const tabs = getFilesTabs().filter((h) => h.root === root);
    const target = tabs.find((h) => h.isVisible()) ?? tabs[0];
    target?.openAtLine(frame.path, frame.line, frame.column || 1);
  }

  function onEvent(root: string, sessionId: string | null, event: string, body: unknown): void {
    update(root, (run) => reduceEvent(run, sessionId, event, body));
    if (event === 'initialized' && sessionId) {
      const key = `${root}\0${sessionId}`;
      initializedWaiters.get(key)?.();
      initializedWaiters.delete(key);
    }
    const l = live(root);
    if (!l) return;
    const b = (body ?? {}) as Record<string, unknown>;
    if (event === 'prontella/session' && typeof b.sessionId === 'string') {
      const isRoot = b.parentSessionId === null;
      const request = isRoot ? l.choice.request : b.request === 'attach' ? 'attach' : 'launch';
      void startSession(root, b.sessionId, request, isRoot ? { name: l.choice.name, file: l.choice.file } : {});
    } else if ((event === 'terminated' && sessionId === get().runs[root]?.rootSession) || (event === 'prontella/status' && b.state === 'failed')) {
      // アダプタープロセスは複数実行を受けられる作りなので自分では終わらない。root が終わったら接続を閉じてサーバーに kill させる
      l.run.close();
    } else if (event === 'stopped' && sessionId) {
      const threadId = typeof b.threadId === 'number' ? b.threadId : null;
      if (threadId !== null) void loadFrames(root, sessionId, threadId);
      else void l.run.request<{ threads?: Array<{ id: number }> }>(sessionId, 'threads', {}).then((r) => {
        const id = r.body?.threads?.[0]?.id;
        if (typeof id === 'number') {
          update(root, (run) => ({ ...run, activeThread: id }));
          void loadFrames(root, sessionId, id);
        }
      });
    }
  }

  return {
    runs: {},
    breakpoints: {},

    ensureBreakpoints(root) {
      const cur = get().breakpoints[root];
      if (cur) return cur;
      const loaded = parseStoredBreakpoints(safeStorageGet(storageKey(root)));
      set((s) => ({ breakpoints: { ...s.breakpoints, [root]: loaded } }));
      return loaded;
    },

    toggleBreakpoint(root, path, line) {
      const next = toggleLines(get().ensureBreakpoints(root), path, line);
      set((s) => ({ breakpoints: { ...s.breakpoints, [root]: next } }));
      safeStorageSet(storageKey(root), JSON.stringify(next));
      const run = get().runs[root];
      if (!run || run.phase === 'idle' || run.phase === 'terminated') return;
      const lines = next[path] ?? [];
      if (lines.length === 0) update(root, (r) => ({ ...r, verified: Object.fromEntries(Object.entries(r.verified).filter(([p]) => p !== path)) }));
      for (const sid of run.sessions) void sendBreakpoints(root, sid, path, lines);
    },

    start(root, choice) {
      if (runs.has(root)) return;
      const run = new DebugRun(root, choice.adapter, {
        onEvent: (sid, event, body) => onEvent(root, sid, event, body),
        onEnd: () => {
          runs.delete(root);
          update(root, (r) => (r.phase === 'terminated' ? r : { ...r, phase: 'terminated', currentLine: null, frames: [], activeFrame: null, scopes: [] }));
        },
      });
      runs.set(root, { run, choice });
      set((s) => ({ runs: { ...s.runs, [root]: { ...emptyRun(), phase: 'starting' } } }));
    },

    stop(root) {
      live(root)?.run.close(); // onEnd が状態を terminated にする
    },

    control(root, command) {
      const l = live(root);
      const run = get().runs[root];
      if (!l || !run) return;
      if (command === 'pause') {
        const sid = run.activeSession ?? run.sessions.find((s) => s !== run.rootSession) ?? run.rootSession;
        if (sid) void l.run.request(sid, 'pause', { threadId: run.activeThread ?? 0 });
        return;
      }
      if (run.phase !== 'stopped' || !run.activeSession) return;
      void l.run.request(run.activeSession, command, { threadId: run.activeThread ?? 0 });
    },

    selectFrame(root, frameId) {
      const run = get().runs[root];
      const frame = run?.frames.find((f) => f.id === frameId);
      if (!frame) return;
      update(root, (r) => ({ ...r, activeFrame: frameId, scopes: [], expanded: [], currentLine: frame.path ? { path: frame.path, line: frame.line } : null }));
      void loadScopes(root, frame);
      revealFrame(root, frame);
    },

    toggleExpand(root, ref) {
      const run = get().runs[root];
      if (!run) return;
      const open = run.expanded.includes(ref);
      update(root, (r) => ({ ...r, expanded: open ? r.expanded.filter((x) => x !== ref) : [...r.expanded, ref] }));
      if (!open && !run.variables[ref] && run.activeSession) void loadVariables(root, run.activeSession, ref);
    },

    evaluate(root, expression) {
      const l = live(root);
      const run = get().runs[root];
      const sid = run?.activeSession ?? run?.sessions.find((s) => s !== run.rootSession);
      if (!l || !run || !sid) return;
      update(root, (r) => reduceEvent(r, sid, 'output', { category: 'input', output: `> ${expression}\n` }));
      void l.run.request<{ result?: string }>(sid, 'evaluate', { expression, context: 'repl', frameId: run.activeFrame ?? undefined }).then((r) => {
        const text = r.success ? `${r.body?.result ?? ''}\n` : `${r.message ?? 'error'}\n`;
        update(root, (s) => reduceEvent(s, sid, 'output', { category: r.success ? 'result' : 'stderr', output: text }));
      });
    },

    clearConsole(root) {
      update(root, (r) => ({ ...r, console: [] }));
    },
  };
});
