import type { WebSocket } from 'ws';
import { metrics } from './metrics/index.js';
import type { SessionInfo } from './pty.js';

const broadcasts = metrics.counter('events.broadcast');
const noSubscribers = metrics.counter('events.noSubscribers');

/**
 * /ws/events のグローバルチャンネル。PTY セッションと SDK (chat) セッションの
 * 両方が同じソケット集合へ SessionInfo を流すため、所有を PtyManager から
 * ここへ切り出した。snapshot は登録された全マネージャーの一覧を合算して返す。
 */

type SnapshotProvider = () => SessionInfo[];

const sockets = new Set<WebSocket>();
const providers: SnapshotProvider[] = [];

export function registerSnapshotProvider(provider: SnapshotProvider): void {
  providers.push(provider);
}

export function attachEvents(ws: WebSocket): void {
  sockets.add(ws);
  ws.send(
    JSON.stringify({
      type: 'snapshot',
      sessions: providers.flatMap((provider) => provider()),
    }),
  );
  ws.on('close', () => sockets.delete(ws));
  ws.on('error', () => sockets.delete(ws));
}

/** メトリクス用: 購読中のソケット数。 */
export function eventsSocketCount(): number {
  return sockets.size;
}

export function broadcastEvent(msg: object): void {
  broadcasts.add();
  if (sockets.size === 0) {
    // 購読者がいないのに JSON 化するのはムダ (集計の「ムダな処理」項目)
    noSubscribers.add();
    return;
  }
  const payload = JSON.stringify(msg);
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}
