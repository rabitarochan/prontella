// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openLiveSocket, type LinkPhase, type LiveSocket } from './liveSocket';

/**
 * 差し替え用の WebSocket。開通・受信・切断をテストから明示的に起こせるようにし、
 * 「送ったのに何も返ってこない」= 半死ソケットも再現できるようにする。
 */
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  closeCalls = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string | ArrayBuffer }) => void) | null = null;
  binaryType = 'blob';
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = FakeWebSocket.CLOSED;
  }

  /** サーバーが接続を受理した。 */
  accept(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  /** サーバーからのメッセージ。 */
  emit(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  /** サーバーからのバイナリフレーム (PTY 出力)。 */
  emitBinary(bytes: number[]): void {
    this.onmessage?.({ data: Uint8Array.from(bytes).buffer });
  }

  /** サーバー / ネットワークによる正常な切断 (close フレームが届いた)。 */
  serverClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  /** ping に pong を返す。 */
  pongPending(): void {
    for (const raw of this.sent.splice(0)) {
      if (JSON.parse(raw)?.type === 'ping') this.emit({ type: 'pong' });
    }
  }

  pingCount(): number {
    return this.sent.filter((raw) => JSON.parse(raw)?.type === 'ping').length;
  }
}

const PING_MS = 20_000;
const PONG_TIMEOUT_MS = 8_000;
// バックオフ最大値 + ジッター上限を必ず超える送り量
const PAST_BACKOFF_MS = 11_000;

let originalWebSocket: unknown;

function last(): FakeWebSocket {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

/** 開通済みのソケットを 1 本作る。 */
function open(overrides: Partial<Parameters<typeof openLiveSocket>[0]> = {}): {
  link: LiveSocket;
  messages: Record<string, unknown>[];
  phases: LinkPhase[];
  opens: number;
} {
  const messages: Record<string, unknown>[] = [];
  const phases: LinkPhase[] = [];
  const state = { opens: 0 };
  const link = openLiveSocket({
    path: '/ws/term?id=abc',
    onMessage: (msg) => messages.push(msg),
    onPhase: (p) => phases.push(p),
    onOpen: () => {
      state.opens += 1;
    },
    ...overrides,
  });
  last().accept();
  return {
    link,
    messages,
    phases,
    get opens() {
      return state.opens;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  originalWebSocket = (globalThis as Record<string, unknown>).WebSocket;
  (globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
});

afterEach(() => {
  vi.useRealTimers();
  (globalThis as Record<string, unknown>).WebSocket = originalWebSocket;
});

describe('openLiveSocket', () => {
  it('接続して onOpen とメッセージを配る', () => {
    const h = open();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(last().url).toContain('/ws/term?id=abc');
    expect(h.opens).toBe(1);
    expect(h.phases).toEqual(['connecting', 'open']);

    last().emit({ type: 'data', data: 'x' });
    expect(h.messages).toEqual([{ type: 'data', data: 'x' }]);
  });

  it('バイナリフレームは onBinary へ届き、onMessage には来ない。受信は生存の証拠になる', () => {
    const binaries: Uint8Array[] = [];
    const h = open({ onBinary: (b) => binaries.push(b) });
    expect(last().binaryType).toBe('arraybuffer');
    // ping を撃って期限を張ってから、pong の代わりにバイナリを受ける
    vi.advanceTimersByTime(PING_MS);
    expect(last().pingCount()).toBe(1);
    last().emitBinary([0x68, 0x69]);
    expect(binaries.map((b) => Array.from(b))).toEqual([[0x68, 0x69]]);
    expect(h.messages).toEqual([]);
    vi.advanceTimersByTime(PONG_TIMEOUT_MS + 1);
    expect(FakeWebSocket.instances).toHaveLength(1); // 期限切れで落とされていない
  });

  it('onBinary 未指定ならバイナリは捨てる (例外にしない)', () => {
    const h = open();
    expect(() => last().emitBinary([1, 2, 3])).not.toThrow();
    expect(h.messages).toEqual([]);
  });

  it('pong は呼び出し側に渡さない', () => {
    const h = open();
    last().emit({ type: 'pong' });
    expect(h.messages).toEqual([]);
  });

  it('正常な切断ならバックオフして再接続し、onOpen が再度呼ばれる', () => {
    const h = open();
    last().serverClose();
    expect(h.phases).toContain('reconnecting');
    expect(FakeWebSocket.instances).toHaveLength(1);

    vi.advanceTimersByTime(PAST_BACKOFF_MS);
    expect(FakeWebSocket.instances).toHaveLength(2);
    last().accept();
    expect(h.opens).toBe(2);
  });

  it('pong が返らなければ (半死) 張り替える', () => {
    open();
    vi.advanceTimersByTime(PING_MS);
    expect(last().pingCount()).toBe(1);

    // 応答なしのまま期限切れ → 古いソケットを閉じて再接続
    const dead = last();
    vi.advanceTimersByTime(PONG_TIMEOUT_MS);
    expect(dead.closeCalls).toBe(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('pong が返っている間は張り替えない (偽陽性が出ないこと)', () => {
    open();
    // ハートビート 10 周期ぶん (= 200 秒) を、毎回 pong を返しながら回す。
    // ping の間隔より pong の期限が短いので、advance は 1 周期ずつ刻む
    // (まとめて進めると pong を返す前に期限が切れてしまう)。
    for (let i = 0; i < 10; i += 1) {
      vi.advanceTimersByTime(PING_MS);
      expect(last().pingCount()).toBe(1);
      last().pongPending();
    }
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(last().closeCalls).toBe(0);
  });

  it('出力が流れているだけでも生存と見なす (pong を待たない)', () => {
    open();
    vi.advanceTimersByTime(PING_MS);
    last().emit({ type: 'data', data: 'out' });
    vi.advanceTimersByTime(PONG_TIMEOUT_MS);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('probe() は閉じたソケットをバックオフ待ちせず即座に繋ぎ直す', () => {
    const h = open();
    last().serverClose();
    expect(FakeWebSocket.instances).toHaveLength(1);

    h.link.probe();
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('probe() は開いているソケットには短い期限付きの ping を撃つ', () => {
    const h = open();
    h.link.probe();
    expect(last().pingCount()).toBe(1);

    vi.advanceTimersByTime(4_000);
    expect(FakeWebSocket.instances).toHaveLength(2); // 無応答なので張り替わる
  });

  it("stop('gone') 後は再接続しない", () => {
    const h = open();
    h.link.stop('gone');
    expect(h.phases[h.phases.length - 1]).toBe('gone');

    last().serverClose();
    vi.advanceTimersByTime(PAST_BACKOFF_MS * 5);
    h.link.probe();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('stop() 後はハートビートも止まる', () => {
    const h = open();
    const ws = last();
    h.link.stop();
    ws.sent.length = 0;
    vi.advanceTimersByTime(PING_MS * 3);
    expect(ws.pingCount()).toBe(0);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('接続していない間の send は false を返して捨てる', () => {
    const h = open();
    expect(h.link.send({ type: 'input', data: 'a' })).toBe(true);
    last().serverClose();
    expect(h.link.send({ type: 'input', data: 'b' })).toBe(false);
  });

  it('再接続が続くとバックオフが伸びる', () => {
    open();
    last().serverClose();
    vi.advanceTimersByTime(400);
    expect(FakeWebSocket.instances).toHaveLength(1); // 500ms 未満では繋がない
    vi.advanceTimersByTime(300);
    expect(FakeWebSocket.instances).toHaveLength(2);

    last().serverClose();
    vi.advanceTimersByTime(900);
    expect(FakeWebSocket.instances).toHaveLength(2); // 2 回目は 1000ms 起点
    vi.advanceTimersByTime(400);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it('再接続に成功するとバックオフがリセットされる', () => {
    open();
    last().serverClose();
    vi.advanceTimersByTime(PAST_BACKOFF_MS);
    last().serverClose();
    vi.advanceTimersByTime(PAST_BACKOFF_MS);
    last().accept();

    // 成功したので次の切断はまた 500ms 起点に戻る
    last().serverClose();
    vi.advanceTimersByTime(700);
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it('タブ復帰 (visibilitychange) で全ソケットを点検する', () => {
    const a = open();
    const b = open({ path: '/ws/events' });
    a.link.send({ type: 'noop' });
    const wsA = FakeWebSocket.instances[0];
    const wsB = FakeWebSocket.instances[1];
    wsA.sent.length = 0;
    wsB.sent.length = 0;

    document.dispatchEvent(new Event('visibilitychange'));
    expect(wsA.pingCount()).toBe(1);
    expect(wsB.pingCount()).toBe(1);
  });
});
