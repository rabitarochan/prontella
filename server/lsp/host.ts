import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { terminalEnv } from '../childEnv.js';
import { metrics } from '../metrics/index.js';
import { createMessageReader, encodeMessage } from './framing.js';
import { createExtTable, type ExtTable } from './uri.js';
import { fsExists, resolveLaunch, type Launch, type LspServerConfig, type ServerId } from './registry.js';

/**
 * (root, serverId) ごとに言語サーバープロセスを 1 つ持ち、複数の WS セッションで共有する。
 *
 * - 1 WS = 1 プロセスにしない: 同じ worktree を 2 タイルで開く・リロードするだけで tsserver が
 *   増殖してインデックスをやり直す
 * - 参照カウントが 0 になっても即座には殺さない (再インデックスは秒〜数十秒)。5 分のアイドルで
 *   shutdown → exit → 3 秒で kill (tsgo は exit 通知の後も生き続けるので kill は必須)
 * - サーバー→クライアント要求には**ここで**答える。ブラウザーには答えようが無く、誰も答えないと
 *   言語サーバーがハングする。未知メソッドは黙殺せず -32601
 * - クラッシュは即再起動しない (次の要求で起動)。60 秒に 3 回で unavailable に固定
 */

export type HostState = 'starting' | 'ready' | 'disabled' | 'unavailable' | 'stopped';

export interface HostStatus {
  state: HostState;
  source?: Launch['source'];
  error?: string;
}

export interface JsonRpcMessage {
  jsonrpc?: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** セッションがプロセスから受け取るイベント。 */
export interface ProcListener {
  onResponse(msg: JsonRpcMessage): void;
  /** プロセスが死んだ/再起動した。doc は全部忘れられたので開き直す。 */
  onReset(): void;
  onStatus(status: HostStatus): void;
}

/** 言語サーバーが知っている 1 ドキュメント。holders はこの doc を開いているセッション、owner は
 *  直近に本文を送ったセッション (LS 側の本文と一致しているのは owner だけ)。 */
export interface DocEntry {
  holders: Set<ProcListener>;
  owner: ProcListener | null;
}

export interface ProcHandle {
  readonly root: string;
  readonly rootToken: string;
  readonly ext: ExtTable;
  readonly status: HostStatus;
  readonly capabilities: unknown;
  /** ディスク URI → doc。プロセスの再起動で空になる。 */
  readonly docs: Map<string, DocEntry>;
  /** クライアント由来の要求。id はセッション側の値のまま渡し、応答は同じ id で onResponse に返る。 */
  request(listener: ProcListener, msg: JsonRpcMessage): void;
  notify(msg: JsonRpcMessage): void;
  /** クライアントの $/cancelRequest。セッション側 id → 子プロセス側 id に引き直す。 */
  cancel(listener: ProcListener, clientId: number | string): void;
  release(listener: ProcListener): void;
  restart(): void;
  /** 停止中 (アイドル停止・クラッシュ後) なら起動し直す。要求を出す前に呼ぶ。 */
  wake(): void;
}

export interface LspHostOptions {
  configFor: (serverId: ServerId) => LspServerConfig;
  /** テスト用の差し替え点 */
  spawn?: typeof nodeSpawn;
  resolve?: (root: string, serverId: ServerId) => Launch | null;
  env?: () => Record<string, string>;
}

const IDLE_MS = 5 * 60_000;
const KILL_GRACE_MS = 3_000;
const MAX_PROCS = 4; // S5: tsgo ≈ 226 MB/プロセス → 4 本で 1 GB 弱
const CRASH_WINDOW_MS = 60_000;
const CRASH_LIMIT = 3;
const STDERR_TAIL = 4096;

const CLIENT_CAPABILITIES = {
  general: { positionEncodings: ['utf-16'] },
  textDocument: {
    synchronization: { didSave: true },
    completion: {
      completionItem: {
        snippetSupport: true,
        insertReplaceSupport: true,
        documentationFormat: ['markdown', 'plaintext'],
        resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] },
      },
    },
    hover: { contentFormat: ['markdown', 'plaintext'] },
    definition: { linkSupport: true },
    publishDiagnostics: {},
  },
  workspace: { configuration: false, workspaceFolders: true },
};

interface Pending {
  listener: ProcListener;
  clientId: number | string;
  end: () => void;
}

interface Proc {
  key: string;
  root: string;
  rootToken: string;
  ext: ExtTable;
  status: HostStatus;
  child: ChildProcess | null;
  capabilities: unknown;
  docs: Map<string, DocEntry>;
  /** initialize 完了前に来たメッセージ (didOpen 等)。ready で流す */
  queue: JsonRpcMessage[];
  nextId: number;
  /** 子プロセス側 id → 元の要求 */
  pending: Map<number, Pending>;
  /** ホスト自身の要求 (initialize / shutdown) */
  own: Map<number, (msg: JsonRpcMessage) => void>;
  listeners: Set<ProcListener>;
  idleTimer: NodeJS.Timeout | null;
  killTimer: NodeJS.Timeout | null;
  stderr: string;
  crashes: number[];
  exited: boolean;
  lastUsed: number;
}

function normalizeRoot(root: string): string {
  const abs = path.resolve(root);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

export class LspHost {
  private procs = new Map<string, Proc>();
  private tokens = new Map<string, string>();
  private unavailable = new Map<string, string>();

  constructor(private readonly opts: LspHostOptions) {}

  private tokenFor(key: string): string {
    let t = this.tokens.get(key);
    if (!t) {
      t = 'r' + randomBytes(4).toString('hex');
      this.tokens.set(key, t);
    }
    return t;
  }

  acquire(root: string, serverId: ServerId, listener: ProcListener): ProcHandle {
    const key = `${normalizeRoot(root)}\0${serverId}`;
    let proc = this.procs.get(key);
    if (!proc) {
      proc = {
        key,
        root: path.resolve(root),
        rootToken: this.tokenFor(key),
        ext: createExtTable(),
        status: { state: 'stopped' },
        child: null,
        capabilities: null,
        docs: new Map(),
        queue: [],
        nextId: 1,
        pending: new Map(),
        own: new Map(),
        listeners: new Set(),
        idleTimer: null,
        killTimer: null,
        stderr: '',
        crashes: [],
        exited: true,
        lastUsed: Date.now(),
      };
      this.procs.set(key, proc);
    }
    proc.listeners.add(listener);
    if (proc.idleTimer) {
      clearTimeout(proc.idleTimer);
      proc.idleTimer = null;
    }
    this.ensureStarted(proc, serverId);
    const p = proc;
    const host = this;
    return {
      root: p.root,
      rootToken: p.rootToken,
      ext: p.ext,
      get status() {
        return p.status;
      },
      get capabilities() {
        return p.capabilities;
      },
      docs: p.docs,
      request(l, msg) {
        host.forwardRequest(p, l, msg);
      },
      notify(msg) {
        p.lastUsed = Date.now();
        host.send(p, msg);
      },
      cancel(l, clientId) {
        for (const [id, pend] of p.pending) {
          if (pend.listener === l && pend.clientId === clientId) {
            host.send(p, { jsonrpc: '2.0', method: '$/cancelRequest', params: { id } });
            return;
          }
        }
      },
      release(l) {
        host.release(p, l);
      },
      restart() {
        host.unavailable.delete(p.key);
        p.crashes = [];
        host.stop(p, 'restart');
        host.ensureStarted(p, serverId);
      },
      wake() {
        if (p.status.state === 'stopped') host.ensureStarted(p, serverId);
      },
    };
  }

  private setStatus(proc: Proc, status: HostStatus): void {
    proc.status = status;
    for (const l of proc.listeners) l.onStatus(status);
  }

  private ensureStarted(proc: Proc, serverId: ServerId): void {
    if (proc.child && !proc.exited) return;
    const frozen = this.unavailable.get(proc.key);
    if (frozen) {
      this.setStatus(proc, { state: 'unavailable', error: frozen });
      return;
    }
    const env = this.opts.env ?? terminalEnv;
    const launch = this.opts.resolve
      ? this.opts.resolve(proc.root, serverId)
      : resolveLaunch({
          root: proc.root,
          config: this.opts.configFor(serverId),
          env: env(),
          platform: process.platform,
          arch: process.arch,
          execPath: process.execPath,
          exists: fsExists,
        });
    if (!launch) {
      this.setStatus(proc, { state: 'disabled' });
      return;
    }
    if (this.liveCount() >= MAX_PROCS && !this.evictIdle()) {
      // ponytail: 全部使用中なら新規を断る。使用中の LRU を落とすと落とされた側が即再取得して往復する
      this.setStatus(proc, { state: 'unavailable', error: `言語サーバーの上限 (${MAX_PROCS}) に達しています` });
      return;
    }
    metrics.count('lsp.spawn');
    this.setStatus(proc, { state: 'starting', source: launch.source });
    // terminalEnv(): 言語サーバーはワークスペースの typescript と tsconfig の plugins (ユーザーのコード)
    // を実行するので、ユーザーの端末と同じ PATH でなければならない (pj-child-env: agentSession と同じ側)。
    // shell: true は禁止 (cp932 化けと注入)。
    const child = (this.opts.spawn ?? nodeSpawn)(launch.command, launch.args, {
      cwd: proc.root,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env(),
    });
    proc.child = child;
    proc.exited = false;
    proc.stderr = '';
    proc.capabilities = null;
    const reader = createMessageReader(
      (msg) => this.onMessage(proc, msg as JsonRpcMessage),
      (err) => {
        proc.stderr += `\n[framing] ${err.message}`;
        this.stop(proc, 'framing');
      },
    );
    child.stdout!.on('data', (chunk: Buffer) => reader.push(chunk));
    child.stderr!.on('data', (chunk: Buffer) => {
      proc.stderr = (proc.stderr + chunk.toString('utf8')).slice(-STDERR_TAIL);
    });
    child.on('error', (err) => {
      proc.stderr += `\n[spawn] ${err.message}`;
    });
    child.on('exit', (code, signal) => {
      if (proc.child !== child) return; // 既に差し替わった古いプロセス
      this.onExit(proc, code, signal);
    });
    this.ownRequest(proc, 'initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(proc.root).href,
      workspaceFolders: [{ uri: pathToFileURL(proc.root).href, name: path.basename(proc.root) }],
      capabilities: CLIENT_CAPABILITIES,
    }).then((msg) => {
      if (proc.child !== child || proc.exited) return;
      if (msg.error) {
        proc.stderr += `\n[initialize] ${msg.error.message}`;
        this.stop(proc, 'initialize');
        return;
      }
      const caps = (msg.result as { capabilities?: { positionEncoding?: string } } | undefined)?.capabilities;
      const enc = caps?.positionEncoding;
      if (enc !== undefined && enc !== 'utf-16') {
        // S3: UTF-8 ↔ UTF-16 の変換層は作らない。対応しないサーバーは使わない
        const error = `positionEncoding=${enc} には対応していません`;
        this.unavailable.set(proc.key, error);
        this.stop(proc, 'encoding');
        this.setStatus(proc, { state: 'unavailable', error });
        return;
      }
      proc.capabilities = caps ?? {};
      // ready にしてから initialized を送る (starting 中の send はキューに入る)。その後にキューを流す
      this.setStatus(proc, { state: 'ready', source: launch.source });
      this.send(proc, { jsonrpc: '2.0', method: 'initialized', params: {} });
      const queued = proc.queue;
      proc.queue = [];
      for (const m of queued) this.send(proc, m);
    });
  }

  private liveCount(): number {
    let n = 0;
    for (const p of this.procs.values()) if (p.child && !p.exited) n++;
    return n;
  }

  private evictIdle(): boolean {
    let victim: Proc | null = null;
    for (const p of this.procs.values()) {
      if (!p.child || p.exited || p.listeners.size > 0) continue;
      if (!victim || p.lastUsed < victim.lastUsed) victim = p;
    }
    if (!victim) return false;
    this.stop(victim, 'evict');
    return true;
  }

  private ownRequest(proc: Proc, method: string, params: unknown): Promise<JsonRpcMessage> {
    const id = proc.nextId++;
    return new Promise((resolve) => {
      proc.own.set(id, resolve);
      this.send(proc, { jsonrpc: '2.0', id, method, params });
    });
  }

  private forwardRequest(proc: Proc, listener: ProcListener, msg: JsonRpcMessage): void {
    proc.lastUsed = Date.now();
    const live = proc.child && !proc.exited && (proc.status.state === 'ready' || proc.status.state === 'starting');
    if (!live || msg.id === undefined) {
      listener.onResponse({ jsonrpc: '2.0', id: msg.id, result: null });
      return;
    }
    const id = proc.nextId++;
    const end = metrics.startSpan('lsp.request', { lsp: spanMethod(msg.method) });
    proc.pending.set(id, { listener, clientId: msg.id, end });
    this.send(proc, { ...msg, id });
  }

  private send(proc: Proc, msg: JsonRpcMessage): void {
    const child = proc.child;
    if (!child || proc.exited || !child.stdin || child.stdin.destroyed) return;
    // initialize 完了前に doc 同期や要求を流すとプロトコル違反 (ホスト自身の initialize は own 経由で素通し)
    if (proc.status.state === 'starting' && !(msg.id !== undefined && proc.own.has(msg.id as number))) {
      proc.queue.push(msg);
      return;
    }
    child.stdin.write(encodeMessage(msg));
  }

  private onMessage(proc: Proc, msg: JsonRpcMessage): void {
    if (msg.id !== undefined && msg.method === undefined) {
      // 応答
      const id = typeof msg.id === 'number' ? msg.id : Number(msg.id);
      const own = proc.own.get(id);
      if (own) {
        proc.own.delete(id);
        own(msg);
        return;
      }
      const pend = proc.pending.get(id);
      if (!pend) return;
      proc.pending.delete(id);
      pend.end();
      pend.listener.onResponse({ ...msg, id: pend.clientId });
      return;
    }
    if (msg.id !== undefined && msg.method !== undefined) {
      // サーバー→クライアント要求。ここで答えないとサーバーがハングする
      this.send(proc, { jsonrpc: '2.0', id: msg.id, ...answerServerRequest(msg) });
      return;
    }
    // 通知 (publishDiagnostics / logMessage / $/progress …) は MVP では捨てる
  }

  private release(proc: Proc, listener: ProcListener): void {
    // このリスナーの pending を空で解決してから外す
    for (const [id, pend] of proc.pending) {
      if (pend.listener === listener) {
        proc.pending.delete(id);
        pend.end();
      }
    }
    proc.listeners.delete(listener);
    if (proc.listeners.size === 0 && proc.child && !proc.exited && !proc.idleTimer) {
      proc.idleTimer = setTimeout(() => {
        proc.idleTimer = null;
        if (proc.listeners.size === 0) this.stop(proc, 'idle');
      }, IDLE_MS);
      proc.idleTimer.unref();
    }
  }

  /** shutdown → exit → 猶予後に kill。exit イベント側で後始末する。 */
  private stop(proc: Proc, reason: string): void {
    const child = proc.child;
    if (!child || proc.exited) return;
    void reason;
    const kill = () => {
      try {
        child.kill();
      } catch {
        // already dead
      }
    };
    if (proc.status.state === 'ready') {
      this.ownRequest(proc, 'shutdown', null).then(() => {
        this.send(proc, { jsonrpc: '2.0', method: 'exit' });
      });
    }
    proc.killTimer = setTimeout(kill, KILL_GRACE_MS);
    proc.killTimer.unref();
    // 意図した停止はクラッシュに数えない
    proc.crashes = [];
    this.setStatus(proc, { state: 'stopped' });
  }

  private onExit(proc: Proc, code: number | null, signal: NodeJS.Signals | null): void {
    if (proc.exited) return;
    proc.exited = true;
    proc.child = null;
    if (proc.killTimer) {
      clearTimeout(proc.killTimer);
      proc.killTimer = null;
    }
    const intended = proc.status.state === 'stopped';
    for (const [, pend] of proc.pending) {
      pend.end();
      pend.listener.onResponse({ jsonrpc: '2.0', id: pend.clientId, result: null });
    }
    proc.pending.clear();
    for (const [, resolve] of proc.own) resolve({ jsonrpc: '2.0', error: { code: -32000, message: 'exited' } });
    proc.own.clear();
    proc.capabilities = null;
    proc.docs.clear();
    proc.queue = [];
    if (!intended) {
      metrics.count('lsp.crash');
      const now = Date.now();
      proc.crashes = proc.crashes.filter((t) => now - t < CRASH_WINDOW_MS);
      proc.crashes.push(now);
      const tail = proc.stderr.trim().split('\n').slice(-3).join('\n');
      if (proc.crashes.length >= CRASH_LIMIT) {
        const error = `言語サーバーが ${CRASH_WINDOW_MS / 1000} 秒に ${CRASH_LIMIT} 回終了しました (code=${code} signal=${signal})${tail ? `\n${tail}` : ''}`;
        this.unavailable.set(proc.key, error);
        this.setStatus(proc, { state: 'unavailable', error });
      } else {
        this.setStatus(proc, { state: 'stopped', error: `言語サーバーが終了しました (code=${code})${tail ? `\n${tail}` : ''}` });
      }
    }
    for (const l of proc.listeners) l.onReset();
    if (proc.listeners.size === 0) this.procs.delete(proc.key);
  }
}

const SPAN_METHODS = new Set(['textDocument/completion', 'textDocument/hover', 'textDocument/definition', 'completionItem/resolve']);
function spanMethod(method: string | undefined): string {
  return method !== undefined && SPAN_METHODS.has(method) ? method : 'other';
}

/** サーバー→クライアント要求への既定応答。 */
export function answerServerRequest(msg: JsonRpcMessage): Pick<JsonRpcMessage, 'result' | 'error'> {
  switch (msg.method) {
    case 'client/registerCapability':
    case 'client/unregisterCapability':
    case 'window/workDoneProgress/create':
      return { result: null };
    case 'workspace/configuration': {
      const items = (msg.params as { items?: unknown[] } | undefined)?.items;
      return { result: Array.isArray(items) ? items.map(() => null) : [] };
    }
    case 'workspace/workspaceFolders':
      return { result: null };
    default:
      return { error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}
