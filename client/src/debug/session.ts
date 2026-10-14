import { openLiveSocket, type LinkPhase, type LiveSocket } from '../lib/liveSocket';

/**
 * 1 デバッグ実行 = 1 本の `/ws/debug` 接続。ワイヤーは素の DAP + `sessionId` (子セッションの多重化)。
 *
 * - LspSession と違い**再接続しない**: 接続が落ちた時点でアダプタープロセスは死んでいる (サーバーが 1 s で kill)。
 *   `reconnecting` / `gone` はどちらも「終了」として扱い、pending は全部 success:false で解決する
 * - pending は宙吊りにしない (LspSession と同じ規律): タイムアウト・切断・送信失敗はすべて resolve
 * - ハンドシェイク (initialize → setBreakpoints → configurationDone → launch/attach) は store 側が
 *   `prontella/session` を受けて回す。ここは要求/応答の対応付けと寿命だけ
 */

/** サーバーの ADAPTER_IDS と同じ。node = vscode-js-debug、csharp = netcoredbg */
export type AdapterId = 'node' | 'csharp';

export interface DapResponse<T = unknown> {
  success: boolean;
  message?: string;
  body?: T;
}

export interface DapEventHandlers {
  onEvent(sessionId: string | null, event: string, body: unknown): void;
  /** 接続が終わった (サーバー切断・アダプター終了・close())。1 回だけ */
  onEnd(): void;
}

interface Pending {
  resolve: (r: DapResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

export const REQUEST_TIMEOUT_MS = 30_000;

export class DebugRun {
  private socket: LiveSocket;
  private seq = 1;
  private pending = new Map<number, Pending>();
  private ended = false;

  constructor(root: string, adapter: AdapterId, private handlers: DapEventHandlers) {
    this.socket = openLiveSocket({
      path: `/ws/debug?root=${encodeURIComponent(root)}&adapter=${adapter}`,
      onMessage: (msg) => this.onMessage(msg),
      onPhase: (phase) => this.onPhase(phase),
    });
  }

  request<T = unknown>(sessionId: string, command: string, args: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<DapResponse<T>> {
    if (this.ended) return Promise.resolve({ success: false, message: 'ended' });
    const seq = this.seq++;
    return new Promise<DapResponse<T>>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(seq)) resolve({ success: false, message: 'timeout' });
      }, timeoutMs);
      if (!this.socket.send({ seq, type: 'request', command, arguments: args, sessionId })) {
        clearTimeout(timer);
        resolve({ success: false, message: 'not connected' });
        return;
      }
      this.pending.set(seq, { resolve: resolve as (r: DapResponse) => void, timer });
    });
  }

  /** 接続を閉じる (サーバーが disconnect → kill を行う)。 */
  close(): void {
    this.end();
  }

  private onMessage(msg: Record<string, unknown>): void {
    if (msg.type === 'response') {
      const p = typeof msg.request_seq === 'number' ? this.pending.get(msg.request_seq) : undefined;
      if (!p) return;
      this.pending.delete(msg.request_seq as number);
      clearTimeout(p.timer);
      // 失敗の本文は `message` か `body.error.format` (js-debug の evaluate エラーは後者だけ)
      const fmt = (msg.body as { error?: { format?: unknown } } | undefined)?.error?.format;
      const message = typeof msg.message === 'string' ? msg.message : typeof fmt === 'string' ? fmt : undefined;
      p.resolve({ success: msg.success === true, message, body: msg.body });
      return;
    }
    if (msg.type === 'event' && typeof msg.event === 'string') {
      this.handlers.onEvent(typeof msg.sessionId === 'string' ? msg.sessionId : null, msg.event, msg.body);
    }
  }

  private onPhase(phase: LinkPhase): void {
    if (phase === 'reconnecting' || phase === 'gone') this.end();
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ success: false, message: 'ended' });
    }
    this.pending.clear();
    this.socket.stop('gone');
    this.handlers.onEnd();
  }
}
