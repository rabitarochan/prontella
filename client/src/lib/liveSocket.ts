/**
 * 再接続とハートビートを内蔵した WebSocket ラッパー。
 *
 * ブラウザーの WebSocket は「TCP が FIN 無しで死ぬ」(PC スリープ・Wi-Fi 切替・VPN)
 * ケースで readyState が OPEN のまま張り付き、close イベントを永久に発火しない。
 * ping/pong は JS に露出しないので、この半死状態はアプリ層のハートビートを
 * 自分で持たない限り検知できない — 送信は無言で捨てられ、症状だけが残る
 * (ターミナルなら「入力が通らない・リサイズが追従しない」)。
 *
 * ハンドルの identity は再接続をまたいで不変。呼び出し側はこのオブジェクトを
 * クロージャーに捕まえておけばよく、差し替わるのは内部の WebSocket だけ。
 */

export type LinkPhase = 'connecting' | 'open' | 'reconnecting' | 'gone';

export interface LiveSocket {
  /** JSON 化して送る。接続が開いていなければ false を返して捨てる。 */
  send(payload: unknown): boolean;
  /** 生存確認を今すぐ撃つ (閉じていればバックオフ待ちを飛ばして即再接続)。 */
  probe(): void;
  /** 恒久停止。'gone' を渡すと phase も 'gone' になる (セッションが消えた場合)。 */
  stop(phase?: 'gone'): void;
}

export interface LiveSocketOptions {
  /** '/ws/term?id=xxx' のようなパス。プロトコルとホストは内部で解決する。 */
  path: string;
  /** JSON パース済みのメッセージ。'pong' は内部で消費するのでここには来ない。 */
  onMessage: (msg: Record<string, unknown>) => void;
  /** バイナリフレーム (PTY 出力の生バイト列)。指定が無ければ捨てる。 */
  onBinary?: (bytes: Uint8Array) => void;
  /** 接続が開くたびに呼ばれる (初回だけでなく再接続でも)。 */
  onOpen?: () => void;
  onPhase?: (phase: LinkPhase) => void;
}

const PING_MS = 20_000;
// 通常のハートビートの猶予。バックグラウンドタブでは setInterval が
// 1 分に 1 回まで絞られるため、間隔より十分短くしても取りこぼしはしない。
const PONG_TIMEOUT_MS = 8_000;
// probe() (可視化・フォーカス復帰) の猶予はユーザーを待たせないよう短く取る。
const PROBE_TIMEOUT_MS = 4_000;
const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000];

/** 生きているソケット。復帰イベントで一斉に probe() するために保持する。 */
const links = new Set<LiveSocketImpl>();
let wired = false;

/**
 * 復帰契機のグローバル購読 (プロセスで一度だけ)。ソケットごとに登録すると
 * ターミナルの枚数だけリスナーが増えるため、ここで一括して配る。
 */
function wireGlobalProbes(): void {
  if (wired || typeof window === 'undefined') return;
  wired = true;
  const kick = () => {
    for (const link of links) link.probe();
  };
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) kick();
  });
  window.addEventListener('focus', kick);
  window.addEventListener('online', kick);
}

class LiveSocketImpl implements LiveSocket {
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private opts: LiveSocketOptions) {
    links.add(this);
    wireGlobalProbes();
    this.setPhase('connecting');
    this.connect();
  }

  private setPhase(phase: LinkPhase): void {
    this.opts.onPhase?.(phase);
  }

  private connect(): void {
    if (this.stopped) return;
    this.clearRetry();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${proto}://${location.host}${this.opts.path}`);
    } catch {
      // コンストラクターが投げるのは URL 不正くらいだが、投げられたまま
      // 再接続が止まると恒久的に死ぬので、必ずバックオフへ載せる。
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    // PTY 出力はバイナリで届く (JSON のエスケープ/パースと UTF-16 変換を省く)。
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.setPhase('open');
      this.startHeartbeat();
      this.opts.onOpen?.();
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      if (event.data instanceof ArrayBuffer) {
        // 何であれ受信は生存の証拠。出力が流れている間は ping を待たずに期限を解く。
        this.clearPongDeadline();
        this.opts.onBinary?.(new Uint8Array(event.data));
        return;
      }
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      this.clearPongDeadline();
      if (msg?.type === 'pong') return;
      this.opts.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopHeartbeat();
      if (this.stopped) return;
      this.setPhase('reconnecting');
      this.scheduleRetry();
    };
    ws.onerror = () => {
      // onerror の後には必ず onclose が来る (仕様)。ここでは何もしない —
      // 握っておかないと未処理の error イベントがコンソールに出る。
    };
  }

  /**
   * 半死ソケットを捨てる。死んだ TCP 上の close() はクローズハンドシェイクの
   * タイムアウトまで onclose を返さないことがあるため、ハンドラーを先に外して
   * onclose を待たずに自分で再接続へ進む。
   */
  private drop(): void {
    const dead = this.ws;
    this.ws = null;
    this.stopHeartbeat();
    if (dead) {
      dead.onopen = null;
      dead.onmessage = null;
      dead.onclose = null;
      dead.onerror = null;
      try {
        dead.close();
      } catch {
        // すでに壊れている — これ以上できることはない
      }
    }
    if (this.stopped) return;
    this.setPhase('reconnecting');
    this.connect();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => this.ping(PONG_TIMEOUT_MS), PING_MS);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.clearPongDeadline();
  }

  private clearPongDeadline(): void {
    if (this.pongTimer !== null) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  /** ping を撃ち、期限内に何も返らなければ死んだと見なす。期限は多重に張らない。 */
  private ping(timeoutMs: number): void {
    if (this.stopped || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.send({ type: 'ping' });
    if (this.pongTimer !== null) return;
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      this.drop();
    }, timeoutMs);
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    this.clearRetry();
    const base = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt += 1;
    // ジッター: 複数ターミナルが同時に切れたとき、再接続が同一フレームに
    // 揃ってサーバーへ突入するのを崩す。
    const delay = base + Math.random() * (base / 4);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  send(payload: unknown): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  probe(): void {
    if (this.stopped) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ping(PROBE_TIMEOUT_MS);
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) return;
    // 閉じている / 閉じかけ: バックオフ待ちを飛ばして今すぐ繋ぎ直す。
    this.attempt = 0;
    this.drop();
  }

  stop(phase?: 'gone'): void {
    if (this.stopped) return;
    this.stopped = true;
    links.delete(this);
    this.clearRetry();
    this.stopHeartbeat();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    if (phase) this.setPhase(phase);
  }
}

export function openLiveSocket(opts: LiveSocketOptions): LiveSocket {
  return new LiveSocketImpl(opts);
}
