import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { terminalEnv } from '../childEnv.js';
import { metrics } from '../metrics/index.js';
import { createMessageReader, encodeMessage } from './framing.js';
import { createExtTable, type ExtTable } from './uri.js';
import { fsExists, fsListDir, resolveLaunch, type Launch, type LspServerConfig, type ServerId } from './registry.js';

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
  /** このプロセスが開いているソリューション (basename)。C# のみ */
  solution?: string;
  /** 温め (didOpen 直後の diagnostic 待ち) 中の doc 数。ready のまま要求が保留される時間を UI が「解析中」と出すため */
  warming?: number;
  /** starting になった時刻 (epoch ms)。tooltip の経過秒数用 */
  since?: number;
}

/**
 * プロセスの単位を root より細かくするための追加キー。Roslyn LS は 1 プロセス 1 ソリューションなので
 * C# は最寄りの .sln ごとにプロセスを持つ。`solution` があれば initialize 後に `solution/open` を送り、
 * `workspace/projectInitializationComplete` が来るまで `starting` に留める。
 */
export interface Workspace {
  key: string;
  solution?: string;
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
  /** 最初の didOpen の languageId。全文差し替えを didClose + didOpen に変換するときに使う */
  languageId: string;
}

export interface ProcHandle {
  readonly root: string;
  readonly solution: string | undefined;
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
  /**
   * didOpen の直後に doc を「温める」: 結果を捨てる textDocument/diagnostic を送り、その応答が返るまで
   * この doc への要求を保留する。Roslyn は意味解析が済む前に来た textDocument/completion に null を返し、
   * しかもその doc の以後の補完が閉じ直すまで null に固定される (RESULTS.md Roslyn R8)。診断の pull は
   * 意味解析の完了と同期するので、時間ではなくこれを待つ
   */
  warm(uri: string): void;
}

export interface LspHostOptions {
  configFor: (serverId: ServerId) => LspServerConfig;
  /** テスト用の差し替え点 */
  spawn?: typeof nodeSpawn;
  resolve?: (root: string, serverId: ServerId) => Launch | null;
  env?: () => Record<string, string>;
  /** テスト用: root の再帰監視。既定は fs.watch({recursive: true}) */
  watch?: (root: string, onEvent: (eventType: string, filename: string | null) => void) => { close(): void };
}

/** LSP の FileChangeType */
const FILE_CREATED = 1;
const FILE_CHANGED = 2;
const FILE_DELETED = 3;
// エディター外の変更 (端末での生成・git checkout・ビルド出力) はまとめて流す。ビルド中は数百件/秒来る
const WATCH_DEBOUNCE_MS = 300;
const WATCH_MAX_BATCH = 500;

// 温めの応答が来ないときの保険 (これを超えたら保留を流す)
const WARM_TIMEOUT_MS = 60_000;

const IDLE_MS = 5 * 60_000;
const KILL_GRACE_MS = 3_000;
// TS + C# 合算。S5: tsgo ≈ 226 MB / R3: Roslyn ≈ 450 MB (ソリューション 1 つ) → 4 本で 2 GB 弱
const MAX_PROCS = 4;
// Roslyn のプロジェクト読込は MSS3.sln (25 プロジェクト) で 25 秒 (R3)。通知が来ない構成の保険
const PROJECT_INIT_TIMEOUT_MS = 180_000;
const CRASH_WINDOW_MS = 60_000;
const CRASH_LIMIT = 3;
const STDERR_TAIL = 4096;
// PRONTELLA_LSP_TRACE=1 で LS との往復 (method / id / エラー) を stdout に出す。本文は出さない
const TRACE = process.env.PRONTELLA_LSP_TRACE === '1';
function trace(dir: '>' | '<', proc: { key: string }, msg: JsonRpcMessage): void {
  if (!TRACE) return;
  const who = proc.key.split('\0').slice(1).join('/');
  const what = msg.method ?? (msg.error ? `error ${msg.error.code} ${msg.error.message}` : `result ${msg.result === null ? 'null' : typeof msg.result}`);
  console.log(`[lsp ${dir}] ${who} ${what}${msg.id !== undefined ? ` #${msg.id}` : ''}`);
}

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
    // 診断は pull のみ使う (push は捨てる。RESULTS.md フェーズ 2: tsgo も Roslyn も push を送ってこない)
    publishDiagnostics: { relatedInformation: true, tagSupport: { valueSet: [1, 2] }, codeDescriptionSupport: true },
    diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
    signatureHelp: {
      signatureInformation: { documentationFormat: ['markdown', 'plaintext'], parameterInformation: { labelOffsetSupport: true }, activeParameterSupport: true },
      contextSupport: true,
    },
    references: {},
  },
  workspace: {
    configuration: false,
    workspaceFolders: true,
    // 申告しないと tsgo も Roslyn もファイル監視を登録してこない (= 端末で作ったファイルを永久に知らない)
    didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
    symbol: { symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) } },
  },
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
  solution: string | undefined;
  /** solution/open 後、projectInitializationComplete 待ち */
  projectInitTimer: NodeJS.Timeout | null;
  /** 温め中の doc → その応答を待っている要求 */
  warming: Map<string, JsonRpcMessage[]>;
  /**
   * `client/registerCapability` で LS が登録した didChangeWatchedFiles の glob (登録 id → 絶対パスの glob)。
   * tsgo は `<root>/**\/*` と node_modules、Roslyn はプロジェクトごとの `**\/*{.cs,.razor,.cshtml}` と
   * .csproj を登録する (RESULTS.md フェーズ 3)。**通知しないと LS は端末で作られたファイルを知らない**
   */
  watchGlobs: Map<string, string[]>;
  watcher: { close(): void } | null;
  /** 監視イベントの保留 (絶対パス → fs.watch の eventType)。デバウンスして 1 通知にまとめる */
  watchPending: Map<string, string>;
  watchTimer: NodeJS.Timeout | null;
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
  private procSeq = 0;

  constructor(private readonly opts: LspHostOptions) {}

  configFor(serverId: ServerId): LspServerConfig {
    return this.opts.configFor(serverId);
  }

  /** root ごとに 1 つ (プロセスごとではない: クライアントの leafId ↔ token 対応は root 単位)。 */
  tokenFor(root: string): string {
    const key = normalizeRoot(root);
    let t = this.tokens.get(key);
    if (!t) {
      t = 'r' + randomBytes(4).toString('hex');
      this.tokens.set(key, t);
    }
    return t;
  }

  acquire(root: string, serverId: ServerId, listener: ProcListener, workspace?: Workspace): ProcHandle {
    const key = `${normalizeRoot(root)}\0${serverId}\0${workspace?.key ?? ''}`;
    let proc = this.procs.get(key);
    if (!proc) {
      proc = {
        key,
        root: path.resolve(root),
        rootToken: this.tokenFor(root),
        solution: workspace?.solution,
        projectInitTimer: null,
        warming: new Map(),
        watchGlobs: new Map(),
        watcher: null,
        watchPending: new Map(),
        watchTimer: null,
        ext: createExtTable(`p${++this.procSeq}`),
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
      solution: p.solution,
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
      warm(uri) {
        host.warm(p, uri);
      },
    };
  }

  private setStatus(proc: Proc, status: HostStatus): void {
    if (proc.solution) status = { ...status, solution: path.basename(proc.solution) };
    if (proc.warming.size > 0) status = { ...status, warming: proc.warming.size };
    if (status.state === 'starting' && status.since === undefined) status = { ...status, since: Date.now() };
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
          serverId,
          config: this.opts.configFor(serverId),
          env: env(),
          platform: process.platform,
          arch: process.arch,
          execPath: process.execPath,
          home: os.homedir(),
          tmpDir: os.tmpdir(),
          pid: process.pid,
          exists: fsExists,
          listDir: fsListDir,
        });
    if (!launch) {
      this.setStatus(proc, { state: 'disabled' });
      return;
    }
    if (launch.logDir) {
      try {
        fs.mkdirSync(launch.logDir, { recursive: true });
      } catch {
        // ログ先が作れなくても起動は試みる (Roslyn は自分でも作る)
      }
    }
    if (this.liveCount() >= MAX_PROCS && !this.evictIdle()) {
      // ponytail: doc を開いているプロセスは落とさない (落とすと落とされた側が即再取得して往復する)。
      // C# は 1 ソリューション 1 プロセスなので上限に当たりやすい — どれを閉じれば空くかを文言で示す
      const open = [...this.procs.values()]
        .filter((p) => p.child && !p.exited)
        .map((p) => (p.solution ? path.basename(p.solution) : path.basename(p.root)))
        .join(', ');
      this.setStatus(proc, { state: 'unavailable', error: `言語サーバーの上限 (${MAX_PROCS}) に達しています。開いているファイルを閉じると空きます: ${open}` });
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
    // 死んでいる間 (unavailable / stopped) に届いた didOpen は docs に記録されるだけで LS には流れていない。
    // 新しいプロセスは何も知らないので、セッションに reset を告げて開き直させる (starting 中の didOpen はキューで待つ)
    if (proc.docs.size > 0) {
      proc.docs.clear();
      for (const l of proc.listeners) l.onReset();
    }
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
      // initialized は starting 中でも直接書く (send はキューに入るため)
      this.writeNow(proc, { jsonrpc: '2.0', method: 'initialized', params: {} });
      if (proc.solution) {
        // Roslyn: solution/open を送り、プロジェクト読込完了の通知を待ってから ready にする。
        // それまでの didOpen はキューで待つ。通知が同期的に返る (テストの偽サーバー) こともあるので
        // タイマーは書き込みより先に立てる
        proc.projectInitTimer = setTimeout(() => this.markReady(proc, launch.source), PROJECT_INIT_TIMEOUT_MS);
        proc.projectInitTimer.unref();
        this.writeNow(proc, { jsonrpc: '2.0', method: 'solution/open', params: { solution: pathToFileURL(proc.solution).href } });
        return;
      }
      this.markReady(proc, launch.source);
    });
  }

  /** ready にしてキューを流す。 */
  private markReady(proc: Proc, source: Launch['source']): void {
    if (proc.projectInitTimer) {
      clearTimeout(proc.projectInitTimer);
      proc.projectInitTimer = null;
    }
    if (proc.exited || proc.status.state !== 'starting') return;
    this.setStatus(proc, { state: 'ready', source });
    const queued = proc.queue;
    proc.queue = [];
    for (const m of queued) this.send(proc, m);
  }

  private writeNow(proc: Proc, msg: JsonRpcMessage): void {
    const child = proc.child;
    if (!child || proc.exited || !child.stdin || child.stdin.destroyed) return;
    trace('>', proc, msg);
    child.stdin.write(encodeMessage(msg));
  }

  private liveCount(): number {
    let n = 0;
    for (const p of this.procs.values()) if (p.child && !p.exited) n++;
    return n;
  }

  /** 誰も使っていない (セッションが無い、または doc を 1 つも開いていない) プロセスの LRU を止める。 */
  private evictIdle(): boolean {
    let victim: Proc | null = null;
    for (const p of this.procs.values()) {
      if (!p.child || p.exited || (p.listeners.size > 0 && p.docs.size > 0)) continue;
      if (!victim || p.lastUsed < victim.lastUsed) victim = p;
    }
    if (!victim) return false;
    this.stop(victim, 'evict');
    return true;
  }

  /** ホスト自身の要求 (initialize / shutdown)。starting 中でもキューを飛ばして書く。 */
  private ownRequest(proc: Proc, method: string, params: unknown): Promise<JsonRpcMessage> {
    const id = proc.nextId++;
    return new Promise((resolve) => {
      proc.own.set(id, resolve);
      this.send(proc, { jsonrpc: '2.0', id, method, params }, true);
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
    const uri = (msg.params as { textDocument?: { uri?: string } } | undefined)?.textDocument?.uri;
    const held = uri !== undefined ? proc.warming.get(uri) : undefined;
    if (held) {
      held.push({ ...msg, id });
      return;
    }
    this.send(proc, { ...msg, id });
  }

  private warm(proc: Proc, uri: string): void {
    if (proc.warming.has(uri)) return;
    const held: JsonRpcMessage[] = [];
    proc.warming.set(uri, held);
    if (proc.status.state === 'ready') this.setStatus(proc, proc.status); // warming 数を載せ直す
    const release = () => {
      if (proc.warming.get(uri) !== held) return;
      proc.warming.delete(uri);
      clearTimeout(timer);
      for (const m of held) if (m.id === undefined || proc.pending.has(m.id as number)) this.send(proc, m);
      if (!proc.exited && proc.status.state === 'ready') this.setStatus(proc, { ...proc.status, warming: undefined });
    };
    const timer = setTimeout(release, WARM_TIMEOUT_MS);
    timer.unref();
    const id = proc.nextId++;
    proc.own.set(id, release);
    this.send(proc, { jsonrpc: '2.0', id, method: 'textDocument/diagnostic', params: { textDocument: { uri } } });
  }

  private send(proc: Proc, msg: JsonRpcMessage, bypassQueue = false): void {
    const child = proc.child;
    if (!child || proc.exited || !child.stdin || child.stdin.destroyed) return;
    // initialize 完了前に doc 同期や要求を流すとプロトコル違反 (ホスト自身の initialize だけ素通し)
    if (proc.status.state === 'starting' && !bypassQueue) {
      proc.queue.push(msg);
      return;
    }
    trace('>', proc, msg);
    child.stdin.write(encodeMessage(msg));
  }

  private onMessage(proc: Proc, msg: JsonRpcMessage): void {
    trace('<', proc, msg);
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
      if (msg.method === 'client/registerCapability') this.registerWatchers(proc, msg.params);
      if (msg.method === 'client/unregisterCapability') this.unregisterWatchers(proc, msg.params);
      this.send(proc, { jsonrpc: '2.0', id: msg.id, ...answerServerRequest(msg) });
      return;
    }
    if (msg.method === 'workspace/projectInitializationComplete' && proc.projectInitTimer) {
      this.markReady(proc, proc.status.source ?? 'config');
      return;
    }
    // 通知 (publishDiagnostics / logMessage / $/progress …) は MVP では捨てる
  }

  // ---- ファイル監視 (workspace/didChangeWatchedFiles) ------------------------

  private registerWatchers(proc: Proc, params: unknown): void {
    const regs = (params as { registrations?: Array<{ id?: string; method?: string; registerOptions?: { watchers?: unknown[] } }> } | undefined)?.registrations ?? [];
    for (const r of regs) {
      if (r.method !== 'workspace/didChangeWatchedFiles' || typeof r.id !== 'string') continue;
      const globs = (r.registerOptions?.watchers ?? []).map((w) => globToAbsolute((w as { globPattern?: unknown }).globPattern)).filter((g): g is string => g !== null);
      proc.watchGlobs.set(r.id, globs);
    }
    if (proc.watchGlobs.size > 0 && !proc.watcher && proc.child && !proc.exited) this.startWatching(proc);
  }

  private unregisterWatchers(proc: Proc, params: unknown): void {
    const list = (params as { unregisterations?: Array<{ id?: string }> } | undefined)?.unregisterations ?? [];
    for (const u of list) if (typeof u.id === 'string') proc.watchGlobs.delete(u.id);
    if (proc.watchGlobs.size === 0) this.stopWatching(proc);
  }

  private startWatching(proc: Proc): void {
    const watch = this.opts.watch ?? ((root, onEvent) => fs.watch(root, { recursive: true }, (e, f) => onEvent(e, f === null ? null : String(f))));
    try {
      proc.watcher = watch(proc.root, (eventType, filename) => this.onWatchEvent(proc, eventType, filename));
      if (TRACE) console.log(`[lsp watch] ${proc.root} globs=${[...proc.watchGlobs.values()].flat().length}`);
    } catch (e) {
      proc.watcher = null; // 監視できない環境 (古い Linux 等) では通知無しで動かす
      if (TRACE) console.log(`[lsp watch] failed: ${(e as Error).message}`);
    }
  }

  private stopWatching(proc: Proc): void {
    proc.watcher?.close();
    proc.watcher = null;
    proc.watchGlobs.clear();
    proc.watchPending.clear();
    if (proc.watchTimer) {
      clearTimeout(proc.watchTimer);
      proc.watchTimer = null;
    }
  }

  private onWatchEvent(proc: Proc, eventType: string, filename: string | null): void {
    if (filename === null) return;
    const rel = filename.split(path.sep).join('/');
    if (rel === '.git' || rel.startsWith('.git/')) return; // git の内部ファイルは LS に無関係で量が多い
    const abs = path.join(proc.root, filename);
    if (!matchesWatch(proc, abs)) return;
    if (proc.watchPending.size >= WATCH_MAX_BATCH && !proc.watchPending.has(abs)) return; // ponytail: 溢れた分は捨てる
    // rename の後に change が来ても rename (存在で Created/Deleted を決める) を優先する
    if (proc.watchPending.get(abs) !== 'rename') proc.watchPending.set(abs, eventType);
    if (!proc.watchTimer) {
      proc.watchTimer = setTimeout(() => this.flushWatch(proc), WATCH_DEBOUNCE_MS);
      proc.watchTimer.unref();
    }
  }

  private flushWatch(proc: Proc): void {
    proc.watchTimer = null;
    const pending = [...proc.watchPending];
    proc.watchPending.clear();
    if (!proc.child || proc.exited) return;
    const changes: Array<{ uri: string; type: number }> = [];
    for (const [abs, eventType] of pending) {
      let exists: boolean;
      try {
        exists = fs.statSync(abs).isFile();
      } catch {
        exists = false;
      }
      if (!exists) {
        // ディレクトリーの生成/削除は Created/Deleted の対象にしない (中のファイルが個別に来る)
        let isDir = false;
        try {
          isDir = fs.statSync(abs).isDirectory();
        } catch {
          isDir = false;
        }
        if (isDir) continue;
        changes.push({ uri: pathToFileURL(abs).href, type: FILE_DELETED });
      } else {
        changes.push({ uri: pathToFileURL(abs).href, type: eventType === 'rename' ? FILE_CREATED : FILE_CHANGED });
      }
    }
    if (changes.length > 0) this.send(proc, { jsonrpc: '2.0', method: 'workspace/didChangeWatchedFiles', params: { changes } });
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
      // tsgo は params: null を「expected no params」と拒む (害は無いが) ので省略する
      this.ownRequest(proc, 'shutdown', undefined).then(() => {
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
    proc.warming.clear();
    proc.queue = [];
    this.stopWatching(proc);
    if (proc.projectInitTimer) {
      clearTimeout(proc.projectInitTimer);
      proc.projectInitTimer = null;
    }
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

const SPAN_METHODS = new Set([
  'textDocument/completion',
  'textDocument/hover',
  'textDocument/definition',
  'completionItem/resolve',
  'textDocument/diagnostic',
  'textDocument/signatureHelp',
  'textDocument/references',
  'workspace/symbol',
]);
function spanMethod(method: string | undefined): string {
  return method !== undefined && SPAN_METHODS.has(method) ? method : 'other';
}

/**
 * LSP の GlobPattern (文字列 or `{baseUri, pattern}`) を絶対パスの glob に正規化する。tsgo は絶対パスの
 * 文字列 (小文字ドライブのことがある)、Roslyn は `{baseUri: file:///…, pattern: '**\/*.cs'}` で来る。
 * 相対パターン (`**\/*.cs` だけ) は root 相対とみなす呼び出し側は無い (来たら null)。
 */
export function globToAbsolute(pattern: unknown): string | null {
  if (typeof pattern === 'string') return path.isAbsolute(pattern) ? pattern : null;
  if (pattern && typeof pattern === 'object') {
    const p = pattern as { baseUri?: unknown; pattern?: unknown };
    const base = typeof p.baseUri === 'string' ? p.baseUri : typeof (p.baseUri as { uri?: unknown } | undefined)?.uri === 'string' ? (p.baseUri as { uri: string }).uri : null;
    if (base === null || typeof p.pattern !== 'string') return null;
    let dir: string;
    try {
      dir = base.startsWith('file:') ? fileURLToPath(base) : base;
    } catch {
      return null;
    }
    return path.join(dir, p.pattern);
  }
  return null;
}

/** 絶対パスが LS の登録した glob のどれかに合うか (Windows は大文字小文字を無視)。 */
export function matchesGlobs(globs: Iterable<string>, abs: string): boolean {
  const norm = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s).split(path.sep).join('/');
  const target = norm(path.resolve(abs));
  for (const g of globs) {
    if (path.posix.matchesGlob(target, norm(g))) return true;
  }
  return false;
}

function matchesWatch(proc: Proc, abs: string): boolean {
  for (const globs of proc.watchGlobs.values()) if (matchesGlobs(globs, abs)) return true;
  return false;
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
