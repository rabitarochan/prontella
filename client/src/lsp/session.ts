import { openLiveSocket, type LinkPhase, type LiveSocket } from '../lib/liveSocket';
import type { ServerId } from './languages';

/**
 * (root, serverId) ごとに 1 本の `/ws/lsp` 接続。ワイヤーは素の JSON-RPC。
 *
 * - pending は「宙吊りにしない」: 再接続・タイムアウト・送信失敗はすべて null で **resolve** する。
 *   宙吊りにすると補完ウィジェットがスピナーのまま張り付き、reject すると unhandledrejection に出る
 * - `liveSocket.send()` の戻り値を必ず見る (未接続時 false。無視すると pending がリークする)
 * - 接続が開くたび (初回でも再接続でも) onOpen を発火する。documents.ts はそこで全 didOpen を送り直す
 */

export type LspState = 'connecting' | 'starting' | 'ready' | 'disabled' | 'unavailable' | 'stopped';

export interface LspStatus {
  state: LspState;
  source?: string;
  error?: string;
  /** C#: このプロセスが開いているソリューション (basename) */
  solution?: string;
  /** 温め (didOpen 直後の diagnostic 待ち) 中の doc 数。ready のまま補完が保留される間「解析中」を出す */
  warming?: number;
  /** starting になった時刻 (epoch ms) */
  since?: number;
}

export interface LspError {
  code: number;
  message: string;
  data?: unknown;
}

/** 要求の結果。`error` は LSP のエラー応答 (not-owner 判定に使う)。null は「無し/取り下げ」。 */
export type LspResult<T> = { result: T | null } | { error: LspError };

export const NOT_OWNER = -32803;

interface Pending {
  resolve: (r: LspResult<unknown>) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class LspSession {
  readonly root: string;
  readonly serverId: ServerId;
  rootToken: string | null = null;
  status: LspStatus = { state: 'connecting' };
  /**
   * LS が initialize で申告した triggerCharacters (ready のたびに取り直す)。Monaco には和集合を静的に登録して
   * いるので、LS が知らない文字は Invoked に落として送る — tsgo は未知の triggerCharacter に
   * -32603 "panic handling request … Unknown trigger character" を返す (実機で `(` と `{`)
   */
  completionTriggers: ReadonlySet<string> | null = null;
  signatureTriggers: ReadonlySet<string> | null = null;
  signatureRetriggers: ReadonlySet<string> | null = null;
  private socket: LiveSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private statusListeners = new Set<(s: LspStatus) => void>();
  readonly onOpen = new Set<() => void>();
  readonly onReset = new Set<() => void>();

  constructor(root: string, serverId: ServerId) {
    this.root = root;
    this.serverId = serverId;
    this.socket = openLiveSocket({
      path: `/ws/lsp?root=${encodeURIComponent(root)}&server=${serverId}`,
      onMessage: (msg) => this.onMessage(msg),
      onOpen: () => {
        for (const l of this.onOpen) l();
      },
      onPhase: (phase) => this.onPhase(phase),
    });
  }

  get ready(): boolean {
    return this.status.state === 'ready' && this.rootToken !== null;
  }

  subscribe(listener: (s: LspStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(s: LspStatus): void {
    const wasReady = this.ready;
    this.status = s;
    for (const l of this.statusListeners) l(s);
    if (this.ready && !wasReady) void this.loadCapabilities();
  }

  private async loadCapabilities(): Promise<void> {
    const r = await this.request<{ capabilities?: { completionProvider?: { triggerCharacters?: string[] }; signatureHelpProvider?: { triggerCharacters?: string[]; retriggerCharacters?: string[] } } }>('initialize', {}, 5_000);
    if ('error' in r || !r.result) return;
    const caps = r.result.capabilities ?? {};
    this.completionTriggers = new Set(caps.completionProvider?.triggerCharacters ?? []);
    this.signatureTriggers = new Set(caps.signatureHelpProvider?.triggerCharacters ?? []);
    this.signatureRetriggers = new Set(caps.signatureHelpProvider?.retriggerCharacters ?? []);
  }

  private onPhase(phase: LinkPhase): void {
    if (phase === 'reconnecting' || phase === 'gone') {
      this.rootToken = null;
      this.resolveAll();
      this.setStatus({ state: phase === 'gone' ? 'disabled' : 'connecting' });
    }
  }

  private resolveAll(): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ result: null });
    }
    this.pending.clear();
  }

  private onMessage(msg: Record<string, unknown>): void {
    const id = msg.id;
    if (typeof id === 'number' && msg.method === undefined) {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      clearTimeout(p.timer);
      const err = msg.error as LspError | undefined;
      p.resolve(err ? { error: err } : { result: (msg.result as unknown) ?? null });
      return;
    }
    if (msg.method === '$/prontella/status') {
      const params = (msg.params ?? {}) as { rootToken?: string; state?: LspState; source?: string; error?: string; solution?: string; warming?: number; since?: number; refused?: boolean };
      if (params.refused) {
        // この root では LSP を提供しない (未登録の root / mode が builtin)。再接続ループにしない
        this.socket.stop('gone');
        return;
      }
      if (params.rootToken) this.rootToken = params.rootToken;
      this.setStatus({ state: params.state ?? 'stopped', source: params.source, error: params.error, solution: params.solution, warming: params.warming, since: params.since });
      return;
    }
    if (msg.method === '$/prontella/reset') {
      this.resolveAll();
      for (const l of this.onReset) l();
    }
  }

  notify(method: string, params: unknown): boolean {
    return this.socket.send({ jsonrpc: '2.0', method, params });
  }

  /**
   * 上限タイムアウト付きの要求。`signal` が立ったら $/cancelRequest を送って null で解決する。
   * 未実装だと tsserver に古い要求が滞留し、打鍵が進むほど候補が遅れる。
   */
  request<T>(method: string, params: unknown, timeoutMs: number, cancel?: { onCancellationRequested: (cb: () => void) => { dispose(): void } }): Promise<LspResult<T>> {
    if (!this.ready) return Promise.resolve({ result: null });
    const id = this.nextId++;
    return new Promise<LspResult<T>>((resolve) => {
      const finish = (r: LspResult<unknown>) => {
        sub?.dispose();
        resolve(r as LspResult<T>);
      };
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          this.notify('$/cancelRequest', { id });
          finish({ result: null });
        }
      }, timeoutMs);
      const sub = cancel?.onCancellationRequested(() => {
        if (this.pending.delete(id)) {
          clearTimeout(timer);
          this.notify('$/cancelRequest', { id });
          finish({ result: null });
        }
      });
      if (!this.socket.send({ jsonrpc: '2.0', id, method, params })) {
        clearTimeout(timer);
        finish({ result: null });
        return;
      }
      this.pending.set(id, { resolve: finish, timer });
    });
  }

  restart(): void {
    this.notify('$/prontella/restart', {});
  }
}

const sessions = new Map<string, LspSession>();

/** 既に張られている接続だけを返す (張らない)。シンボル検索など、そのために LS を起動したくない用途 */
export function peekLspSession(root: string, serverId: ServerId): LspSession | null {
  return sessions.get(`${root}\0${serverId}`) ?? null;
}

/** (root, serverId) の接続を得る (無ければ張る)。切らない — LS 側の寿命はサーバーのアイドル停止が持つ。 */
export function getLspSession(root: string, serverId: ServerId): LspSession {
  const key = `${root}\0${serverId}`;
  let s = sessions.get(key);
  if (!s) {
    s = new LspSession(root, serverId);
    sessions.set(key, s);
  }
  return s;
}
