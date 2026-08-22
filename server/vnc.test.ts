import net from 'node:net';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLOSE_CONNECT_FAILED,
  CLOSE_TCP_DROPPED,
  activeBridgeCount,
  attachVncBridge,
  checkVncConfig,
  resolveVncTarget,
  type BridgeSocket,
} from './vnc.js';

// ---- checkVncConfig ----------------------------------------------------------

describe('checkVncConfig', () => {
  it('returns the default target for undefined / null', () => {
    for (const value of [undefined, null]) {
      const result = checkVncConfig(value);
      expect(result).toEqual({ ok: true, target: { host: '127.0.0.1', port: 5900 } });
    }
  });

  it('accepts a full host+port object', () => {
    expect(checkVncConfig({ host: '192.168.1.10', port: 5901 })).toEqual({
      ok: true,
      target: { host: '192.168.1.10', port: 5901 },
    });
  });

  it('fills omitted fields with defaults', () => {
    expect(checkVncConfig({ host: 'vnc-host' })).toEqual({
      ok: true,
      target: { host: 'vnc-host', port: 5900 },
    });
    expect(checkVncConfig({ port: 5999 })).toEqual({
      ok: true,
      target: { host: '127.0.0.1', port: 5999 },
    });
  });

  it('rejects non-object values (typeof check first)', () => {
    for (const value of ['127.0.0.1:5900', 42, true, ['127.0.0.1', 5900]]) {
      const result = checkVncConfig(value);
      expect(result.ok).toBe(false);
    }
  });

  it('rejects invalid hosts (empty / control chars / whitespace)', () => {
    const controlHost = `ho${String.fromCodePoint(9)}st`; // TAB を文字コードで組み立てる
    for (const host of ['', ' ', 'host name', controlHost, 123, ['a'], null]) {
      const result = checkVncConfig({ host });
      expect(result.ok, `host=${JSON.stringify(host)}`).toBe(false);
    }
  });

  it('rejects invalid ports (string / float / out of range / array)', () => {
    for (const port of ['5900', 1.5, 0, -1, 65536, NaN, [5900], null]) {
      const result = checkVncConfig({ port });
      expect(result.ok, `port=${JSON.stringify(port)}`).toBe(false);
    }
  });
});

// ---- resolveVncTarget --------------------------------------------------------

describe('resolveVncTarget', () => {
  it('prefers env over config over defaults', () => {
    const target = resolveVncTarget(
      { host: 'config-host', port: 6000 },
      { host: 'env-host', port: '6001' },
      () => {},
    );
    expect(target).toEqual({ host: 'env-host', port: 6001 });
  });

  it('falls back to defaults and logs when config is invalid', () => {
    const logs: string[] = [];
    const target = resolveVncTarget('bogus', {}, (m) => logs.push(m));
    expect(target).toEqual({ host: '127.0.0.1', port: 5900 });
    expect(logs).toHaveLength(1);
  });

  it('ignores invalid env values and keeps config values', () => {
    const logs: string[] = [];
    const target = resolveVncTarget(
      { host: 'config-host', port: 6000 },
      { host: 'bad host', port: 'not-a-number' },
      (m) => logs.push(m),
    );
    expect(target).toEqual({ host: 'config-host', port: 6000 });
    expect(logs).toHaveLength(2);
  });
});

// ---- attachVncBridge ---------------------------------------------------------

/**
 * ws.WebSocket の偽物。send/close を記録し、close はループバックで 'close' を発火する
 * (実 ws の close ハンドシェイクの簡略形 — finish() の二重終了ガードの検証も兼ねる)。
 */
class FakeWs extends EventEmitter implements BridgeSocket {
  readyState = 1;
  bufferedAmount = 0;
  sent: Buffer[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private sendCallbacks: Array<(err?: Error) => void> = [];

  send(data: Buffer, _options: { binary: boolean }, cb?: (err?: Error) => void): void {
    this.sent.push(Buffer.from(data));
    if (cb) this.sendCallbacks.push(cb);
  }

  /** 溜まった send callback を発火する (カーネルへの書き出し完了を模す)。 */
  flushSendCallbacks(): void {
    const cbs = this.sendCallbacks;
    this.sendCallbacks = [];
    for (const cb of cbs) cb();
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = { code, reason };
    this.readyState = 3;
    this.emit('close');
  }

  sentBytes(): Buffer {
    return Buffer.concat(this.sent);
  }
}

interface MockServer {
  port: number;
  sockets: net.Socket[];
  received: Buffer[];
  close(): Promise<void>;
}

/** ephemeral ポートで受信内容を記録するだけの TCP サーバーを立てる。 */
function listenMock(onSocket?: (socket: net.Socket) => void): Promise<MockServer> {
  return new Promise((resolve) => {
    const sockets: net.Socket[] = [];
    const received: Buffer[] = [];
    const server = net.createServer((socket) => {
      sockets.push(socket);
      socket.on('data', (chunk) => received.push(chunk));
      socket.on('error', () => {});
      onSocket?.(socket);
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        sockets,
        received,
        close: () =>
          new Promise((res) => {
            for (const s of sockets) s.destroy();
            server.close(() => res());
          }),
      });
    });
  });
}

describe('attachVncBridge', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
    // どのテストの後もブリッジが残っていないこと (対称クリーンアップの回帰)
    await vi.waitFor(() => expect(activeBridgeCount()).toBe(0));
  });

  it('pipes bytes in both directions transparently', async () => {
    const mock = await listenMock((socket) => socket.write(Buffer.from('RFB 003.008\n')));
    cleanups.push(mock.close);
    const ws = new FakeWs();
    attachVncBridge(ws, { host: '127.0.0.1', port: mock.port });

    // サーバー先行バイトが WS 側へバイナリーのまま届く
    await vi.waitFor(() => expect(ws.sentBytes().toString('latin1')).toBe('RFB 003.008\n'));

    // クライアントフレームがサーバーへバイト一致で届く
    const clientBytes = Buffer.from([0x52, 0x46, 0x42, 0x00, 0xff, 0x10]);
    ws.emit('message', clientBytes, true);
    await vi.waitFor(() => expect(Buffer.concat(mock.received)).toEqual(clientBytes));

    ws.close();
    await vi.waitFor(() => expect(activeBridgeCount()).toBe(0));
  });

  it('buffers frames arriving before the TCP connection and flushes them in order', async () => {
    const mock = await listenMock();
    cleanups.push(mock.close);
    const ws = new FakeWs();
    attachVncBridge(ws, { host: '127.0.0.1', port: mock.port });
    // attach 直後 (connect コールバックは必ず後のティック) に同期で送る = 接続前フレーム
    ws.emit('message', Buffer.from('first'), true);
    ws.emit('message', Buffer.from('second'), true);

    await vi.waitFor(() =>
      expect(Buffer.concat(mock.received).toString('latin1')).toBe('firstsecond'),
    );
    ws.close();
  });

  it('closes with 4000 when the VNC server is unreachable', async () => {
    // listen していないポート = ECONNREFUSED (listenMock を開いてすぐ閉じてポートを確保)
    const mock = await listenMock();
    await mock.close();
    const ws = new FakeWs();
    attachVncBridge(ws, { host: '127.0.0.1', port: mock.port });
    await vi.waitFor(() => expect(ws.closed?.code).toBe(CLOSE_CONNECT_FAILED));
  });

  it('closes with 4001 when the TCP side drops after connecting', async () => {
    const mock = await listenMock((socket) => {
      setTimeout(() => socket.destroy(), 10);
    });
    cleanups.push(mock.close);
    const ws = new FakeWs();
    attachVncBridge(ws, { host: '127.0.0.1', port: mock.port });
    await vi.waitFor(() => expect(ws.closed?.code).toBe(CLOSE_TCP_DROPPED));
  });

  it('destroys the TCP socket when the WS side closes first', async () => {
    const mock = await listenMock();
    cleanups.push(mock.close);
    const ws = new FakeWs();
    attachVncBridge(ws, { host: '127.0.0.1', port: mock.port });
    await vi.waitFor(() => expect(mock.sockets).toHaveLength(1));

    const socketClosed = new Promise<void>((res) => mock.sockets[0].on('close', () => res()));
    ws.emit('close');
    await socketClosed;
    expect(activeBridgeCount()).toBe(0);
    // WS 起点の終了ではブリッジから ws.close を呼ばない (二重 close しない)
    expect(ws.closed).toBeNull();
  });

  it('rejects text frames as a protocol violation', async () => {
    const mock = await listenMock();
    cleanups.push(mock.close);
    const ws = new FakeWs();
    attachVncBridge(ws, { host: '127.0.0.1', port: mock.port });
    ws.emit('message', Buffer.from('{"type":"error"}'), false);
    await vi.waitFor(() => expect(ws.closed?.code).toBe(1003));
  });

  it('pauses the TCP socket above the WS high-water mark and resumes below it', async () => {
    let serverSocket: net.Socket | null = null;
    const mock = await listenMock((socket) => {
      serverSocket = socket;
    });
    cleanups.push(mock.close);
    const ws = new FakeWs();
    attachVncBridge(ws, { host: '127.0.0.1', port: mock.port });
    await vi.waitFor(() => expect(serverSocket).not.toBeNull());

    // 高水位超過を偽装してからチャンクを流す → ブリッジは TCP を pause する
    ws.bufferedAmount = 8 * 1024 * 1024;
    serverSocket!.write(Buffer.alloc(1024));
    await vi.waitFor(() => expect(ws.sent).toHaveLength(1));

    // pause 中は後続チャンクが ws へ届かない (data イベントが止まる)
    serverSocket!.write(Buffer.alloc(256));
    await new Promise((res) => setTimeout(res, 50));
    expect(ws.sent).toHaveLength(1);

    // 低水位に戻して send callback を発火 → resume され、滞留チャンクが届く
    ws.bufferedAmount = 0;
    ws.flushSendCallbacks();
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThanOrEqual(2));
    ws.close();
  });
});
