import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WebSocket } from 'ws';
import { terminalEnv } from '../childEnv.js';
import { safeResolve } from '../files.js';
import { metrics } from '../metrics/index.js';
import { fsExists, fsListDir } from '../lsp/registry.js';
import { startAdapter, type Adapter, type AdapterConn, type DapMessage } from './host.js';
import { resolveLaunchRequest } from './launchConfig.js';
import { downloadAdapter, resolveAdapter, type AdapterId, type DebugAdapterConfig, type DownloadDeps, type Launch, type ResolveEnv } from './registry.js';

/**
 * 1 WebSocket = 1 デバッグ実行 = アダプタープロセス 1 本。ワイヤーは素の DAP に `sessionId` を 1 つ足したもの。
 *
 * - vscode-js-debug は root 接続を「ランチャー」にし、実際のターゲットは `startDebugging` 逆要求 → 別 TCP 接続で
 *   動く (被デバッグが spawn した孫プロセスも同様。RESULTS.md D3)。ここは接続の集合を持ち、`sessionId` で多重化する
 * - クライアントは launch/attach の本体を送ってこない: root は `{name}` (launch.json) か `{file}` (内蔵既定)、
 *   子は空。本体はサーバーが組む/注入する → ブラウザー由来の絶対パスや任意コマンドがアダプターに届かない
 * - パス: アダプター→クライアントは `source.path` を root 相対に (root 外は path を消す)、クライアント→アダプターは
 *   `setBreakpoints.arguments.source.path` だけ safeResolve で絶対化する
 * - サーバー側の状態は合成イベント `prontella/status` / `prontella/session` で伝える
 * - 後始末: root に disconnect{terminateDebuggee} を送り、応答は待たずに 1 秒で kill (D7: kill 単独でも debuggee は消える)
 */

const ALLOWED_COMMANDS = new Set([
  'initialize', 'setBreakpoints', 'setExceptionBreakpoints', 'configurationDone', 'launch', 'attach',
  'threads', 'stackTrace', 'scopes', 'variables', 'evaluate', 'continue', 'next', 'stepIn', 'stepOut', 'pause',
  'disconnect', 'terminate', 'source',
]);
/** クライアントに流さないイベント。loadedSource (js-debug) は 1 実行で 100 件超、module (netcoredbg) も十数件。telemetry は使わない */
const DROP_EVENTS = new Set(['loadedSource', 'module']);
const KILL_GRACE_MS = 1_000;
const TRACE = process.env.PRONTELLA_DAP_TRACE === '1';

export type DebugState = 'resolving' | 'downloading' | 'starting' | 'ready' | 'failed' | 'exited';

export interface DebugDeps {
  adapter: AdapterId;
  config: DebugAdapterConfig;
  toolsDir: string;
  /** テスト用の差し替え点 */
  env?: () => Record<string, string>;
  resolve?: (r: ResolveEnv, id: AdapterId) => Launch | null;
  download?: (id: AdapterId, deps: DownloadDeps) => Promise<string>;
  start?: typeof startAdapter;
  readLaunchJson?: (root: string) => string | null;
  exists?: (abs: string) => boolean;
  listDir?: (abs: string) => string[];
}

interface Session {
  id: string;
  conn: AdapterConn;
  parent: string | null;
  /** 子: startDebugging が寄越した launch/attach 引数。クライアントの launch/attach にこれを注入する */
  pending: { request: string; configuration: unknown } | null;
  /** サーバー自身が送る要求/応答の seq。クライアントの seq と衝突しない範囲 */
  ownSeq: number;
}

export function readLaunchJson(root: string): string | null {
  try {
    return fs.readFileSync(path.join(root, '.vscode', 'launch.json'), 'utf8');
  } catch {
    return null;
  }
}

export function attachDebug(ws: WebSocket, root: string, deps: DebugDeps): void {
  metrics.count('debug.session');
  const rootAbs = path.resolve(root);
  const exists = deps.exists ?? fsExists;
  const listDir = deps.listDir ?? fsListDir;
  const sessions = new Map<string, Session>();
  let adapter: Adapter | null = null;
  let closed = false;
  let nextSession = 1;

  const send = (msg: DapMessage & { sessionId?: string }) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const status = (state: DebugState, extra: { error?: string; source?: string } = {}) => {
    if (TRACE) console.log(`[dap status] ${state} ${extra.error ?? ''}`);
    send({ type: 'event', event: 'prontella/status', body: { state, ...extra } });
  };
  const fail = (error: string) => {
    status('failed', { error });
    ws.close(4004, 'debug adapter unavailable');
  };

  // ---- パス書き換え -----------------------------------------------------------
  /**
   * root 内なら root 相対 (`/` 区切り)、外なら null。win32 の path.relative は大小文字を無視して比較し、
   * 戻り値の各セグメントは `abs` 側の表記を保つ (js-debug の小文字ドライブも netcoredbg の正しい大小文字もそのまま通る)
   */
  const toRelative = (abs: string): string | null => {
    if (!path.isAbsolute(abs)) return null;
    const rel = path.relative(rootAbs, abs);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join('/');
  };
  const escapeRe = (s: string) => s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  const reFlags = process.platform === 'win32' ? 'gi' : 'g';
  const homeRe = new RegExp(escapeRe(os.homedir()), reFlags);
  const nodeDirRe = new RegExp(escapeRe(path.dirname(process.execPath)), reFlags);
  /** 実パスをブラウザーに出さない: js-debug は `source.name` にも絶対パスを入れ、起動コマンド行を output で流す */
  const toClient = (value: unknown): unknown => {
    const out = rewriteSources(value, (src) => {
      const rel = typeof src.path === 'string' ? toRelative(src.path) : null;
      // name が絶対パスそのものなら basename に (`<node_internals>/fs` のような疑似パスはそのまま)
      const name = typeof src.name === 'string' && src.name === src.path && path.isAbsolute(src.name) ? path.basename(src.name) : src.name;
      if (rel !== null) return { ...src, name, path: rel };
      const { path: _dropped, ...rest } = src;
      return { ...rest, name };
    }) as DapMessage;
    const body = out.body as { category?: string; output?: unknown } | undefined;
    // ponytail: output の本文はホームと node のディレクトリーを潰すだけ (起動コマンド行 `<node>/node.exe .\src\main.js` の形)
    if (out.type === 'event' && out.event === 'output' && body && typeof body.output === 'string') {
      out.body = { ...body, output: body.output.replace(nodeDirRe, '<node>').replace(homeRe, '~') };
    }
    return out;
  };

  // ---- アダプター → クライアント ------------------------------------------------
  function onAdapterMessage(s: Session, msg: DapMessage): void {
    if (TRACE) console.log(`[dap <] ${s.id} ${msg.type} ${msg.command ?? msg.event ?? ''} ${msg.request_seq ?? msg.seq ?? ''}`);
    if (msg.type === 'request') return onReverseRequest(s, msg);
    if (msg.type === 'event') {
      if (DROP_EVENTS.has(msg.event ?? '')) return;
      if (msg.event === 'output' && (msg.body as { category?: string } | undefined)?.category === 'telemetry') return;
    }
    send({ ...(toClient(msg) as DapMessage), sessionId: s.id });
  }

  function onReverseRequest(s: Session, msg: DapMessage): void {
    const reply = (body: Pick<DapMessage, 'success' | 'message' | 'body'>) =>
      s.conn.send({ seq: s.ownSeq++, type: 'response', request_seq: msg.seq, command: msg.command, ...body });
    if (msg.command === 'startDebugging' && adapter) {
      const args = (msg.arguments ?? {}) as { request?: unknown; configuration?: unknown };
      const request = args.request === 'attach' ? 'attach' : 'launch';
      const child = openSession(s.id, { request, configuration: args.configuration });
      reply({ success: true });
      send({ type: 'event', event: 'prontella/session', body: { sessionId: child.id, parentSessionId: s.id, request } });
      return;
    }
    // runInTerminal: MVP は internalConsole のみ (env を渡せる PTY が無い。RESULTS.md D9)
    reply({ success: false, message: `${msg.command} には対応していません` });
  }

  function openSession(parent: string | null, pending: Session['pending']): Session {
    const id = `s${nextSession++}`;
    const s: Session = { id, parent, pending, ownSeq: 1_000_000, conn: null as unknown as AdapterConn };
    s.conn = adapter!.connect(
      (msg) => onAdapterMessage(s, msg),
      () => sessions.delete(id),
    );
    sessions.set(id, s);
    return s;
  }

  // ---- クライアント → アダプター ------------------------------------------------
  ws.on('message', (raw) => {
    let msg: DapMessage & { sessionId?: unknown };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || msg.type !== 'request') return; // keepAlive の ping 等
    const { command, seq, sessionId } = msg;
    if (typeof command !== 'string' || typeof seq !== 'number') return;
    const s = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
    const reject = (message: string) => send({ seq: 0, type: 'response', request_seq: seq, command, success: false, message, sessionId: typeof sessionId === 'string' ? sessionId : undefined });
    if (!s) return reject('セッションがありません');
    if (!ALLOWED_COMMANDS.has(command)) return reject(`対応していないコマンドです: ${command}`);
    let args: unknown = msg.arguments;
    if (command === 'launch' || command === 'attach') {
      if (s.pending) {
        if (s.pending.request !== command) return reject(`このセッションは ${s.pending.request} で開始します`);
        args = s.pending.configuration;
      } else {
        const r = resolveLaunchRequest(rootAbs, (args ?? {}) as Record<string, unknown>, { readLaunchJson: () => (deps.readLaunchJson ?? readLaunchJson)(rootAbs), exists, listDir }, deps.adapter);
        if (!r.ok) return reject(r.error);
        if (r.config.request !== command) return reject(`この設定は ${r.config.request} で開始します`);
        args = r.config;
      }
    } else if (command === 'setBreakpoints') {
      const a = args as { source?: { path?: unknown } } | undefined;
      const rel = a?.source?.path;
      if (typeof rel !== 'string') return reject('source.path が必要です');
      try {
        args = { ...a, source: { ...a!.source, path: safeResolve(rootAbs, rel) } };
      } catch {
        return reject('source.path が root 外を指しています');
      }
    }
    if (TRACE) console.log(`[dap >] ${s.id} request ${command} ${seq}`);
    s.conn.send({ seq, type: 'request', command, arguments: args });
  });

  // ---- 起動 ---------------------------------------------------------------------
  void (async () => {
    try {
      status('resolving');
      const env = withNodeFallback((deps.env ?? terminalEnv)());
      const envPath = env[Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'];
      const resolveEnv: ResolveEnv = { config: deps.config, execPath: process.execPath, home: os.homedir(), toolsDir: deps.toolsDir, envPath, exists, listDir };
      const resolve = deps.resolve ?? resolveAdapter;
      let launch = resolve(resolveEnv, deps.adapter);
      if (!launch) {
        status('downloading');
        await (deps.download ?? downloadAdapter)(deps.adapter, { toolsDir: deps.toolsDir });
        launch = resolve(resolveEnv, deps.adapter);
        if (!launch) throw new Error('ダウンロード後もアダプターが見つかりません');
      }
      if (closed) return;
      status('starting', { source: launch.source });
      metrics.count('debug.spawn');
      const a = await (deps.start ?? startAdapter)({
        launch,
        cwd: rootAbs,
        env,
        onExit: () => {
          // 起動前 (listen 前) の終了は startAdapter の reject → failed で伝える。ready 後の終了だけがここ
          if (closed || !adapter) return;
          status('exited');
          ws.close(1000, 'debug adapter exited');
        },
      });
      if (closed) {
        a.kill();
        return;
      }
      adapter = a;
      const rootSession = openSession(null, null);
      status('ready', { source: launch.source });
      send({ type: 'event', event: 'prontella/session', body: { sessionId: rootSession.id, parentSessionId: null, request: null } });
    } catch (e) {
      if (!closed) fail(e instanceof Error ? e.message : String(e));
    }
  })();

  const cleanup = () => {
    if (closed) return;
    closed = true;
    const a = adapter;
    if (!a) return;
    const rootSession = [...sessions.values()].find((s) => s.parent === null);
    rootSession?.conn.send({ seq: rootSession.ownSeq++, type: 'request', command: 'disconnect', arguments: { terminateDebuggee: true } });
    setTimeout(() => a.kill(), KILL_GRACE_MS).unref();
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
}

/**
 * js-debug は `runtimeExecutable` 既定 `node` を PATH から引く。`terminalEnv()` はレジストリー再構成なので、
 * mise / Volta のようにシェルの profile でだけ node を PATH に入れる環境では見つからない。prontella 自身の
 * node のディレクトリーを PATH の**末尾**に足す (ユーザーの node があればそちらが勝つ。pj-child-env の決定則)。
 */
export function withNodeFallback(env: Record<string, string>, execPath = process.execPath, platform = process.platform): Record<string, string> {
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const sep = platform === 'win32' ? ';' : ':';
  const current = env[pathKey] ?? '';
  return { ...env, [pathKey]: current ? `${current}${sep}${path.dirname(execPath)}` : path.dirname(execPath) };
}

type SourceLike = Record<string, unknown> & { path?: unknown };

/** 値の中の `source: {path}` オブジェクトを全部 fn に通す (stackFrames / breakpoints / output など)。 */
export function rewriteSources(value: unknown, fn: (src: SourceLike) => unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => rewriteSources(v, fn));
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'source' && v !== null && typeof v === 'object' && !Array.isArray(v) && 'path' in v) out[k] = fn(v as SourceLike);
    else out[k] = rewriteSources(v, fn);
  }
  return out;
}
