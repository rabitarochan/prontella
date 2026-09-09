import type { WebSocket } from 'ws';
import type { WS_PATHS } from './names.js';
import type { Registry } from './registry.js';

export type WsPath = (typeof WS_PATHS)[number];

/**
 * WebSocket 1 本ぶんの計測: path 別の接続数ゲージ、受信/送信のフレーム数とバイト数。
 *
 * 送信は `ws.send` をラップして数える (pty / agentSession / sessionEvents / keepAlive の
 * 各送信元に触らずに済む)。ws は複数の 'message' リスナーを許す (wsKeepAlive.ts と同じ理由で
 * 既存ハンドラーには触らない)。レジストリが無効なら何も付けない — 有効化前に開いたソケットは
 * 計測されないが、それは許容する (次の接続から数えればよい)。
 */

const live = new Map<WsPath, number>();

function byteLength(data: unknown): number {
  if (typeof data === 'string') return Buffer.byteLength(data, 'utf8');
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (Array.isArray(data)) {
    let total = 0;
    for (const chunk of data) total += byteLength(chunk);
    return total;
  }
  return 0;
}

export function instrumentSocket(registry: Registry, ws: WebSocket, path: WsPath): void {
  if (!registry.enabled) return;
  const labels = { path };
  live.set(path, (live.get(path) ?? 0) + 1);
  registry.gauge('ws.open', live.get(path) ?? 0, labels);

  const framesIn = registry.counter('ws.frames.in', labels);
  const bytesIn = registry.counter('ws.bytes.in', labels);
  const framesOut = registry.counter('ws.frames.out', labels);
  const bytesOut = registry.counter('ws.bytes.out', labels);

  ws.on('message', (data) => {
    framesIn.add();
    bytesIn.add(byteLength(data));
  });

  const originalSend = ws.send.bind(ws) as (...args: unknown[]) => void;
  (ws as { send: unknown }).send = (...args: unknown[]) => {
    framesOut.add();
    bytesOut.add(byteLength(args[0]));
    return originalSend(...args);
  };

  ws.once('close', () => {
    live.set(path, Math.max(0, (live.get(path) ?? 1) - 1));
    registry.gauge('ws.open', live.get(path) ?? 0, labels);
  });
}

/** テスト用。 */
export function resetWsCounts(): void {
  live.clear();
}
