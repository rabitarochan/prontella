import type { WebSocket } from 'ws';

/**
 * WebSocket の生存維持。2 つの役割を持つ:
 *
 * 1. クライアント (client/src/lib/liveSocket.ts) のアプリ層ハートビートへの応答。
 *    ブラウザーの WebSocket API は protocol ping/pong を JS に露出しないため、
 *    クライアントは自前の {type:'ping'} を投げるしかない。ここで pong を返す。
 * 2. 死んだソケットの回収。TCP が FIN 無しで切れると 'close' は発火せず、
 *    ソケットがセッションの購読集合 (pty.ts の session.sockets) に残り続け、
 *    出力を書き込み続ける。protocol ping への無応答で検出して terminate する。
 *
 * 既存の message ハンドラーには触らない — ws は複数リスナーを許し、
 * pty / agentSession / sessionEvents はいずれも未知の type を無視する。
 *
 * 注意: JSON テキストをやり取りするエンドポイント専用。/ws/vnc のような
 * 生バイナリのブリッジに使うとストリームを壊す。
 */

const PING_MS = 30_000;
// クライアントの ping 間隔 (20 秒) の 3 周期ぶん。ブラウザーのバックグラウンド
// タブでは setInterval が 1 分に 1 回まで絞られるため、それでも切らない幅を取る。
const DEAD_MS = 150_000;

export function keepAlive(ws: WebSocket): void {
  let lastSeen = Date.now();

  ws.on('message', (raw) => {
    lastSeen = Date.now();
    let msg: { type?: unknown };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg?.type === 'ping' && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'pong' }));
    }
  });
  ws.on('pong', () => {
    lastSeen = Date.now();
  });

  const timer = setInterval(() => {
    if (Date.now() - lastSeen > DEAD_MS) {
      ws.terminate();
      return;
    }
    if (ws.readyState === ws.OPEN) {
      try {
        ws.ping();
      } catch {
        // 送信直前に閉じた — 次の tick で回収される
      }
    }
  }, PING_MS);
  timer.unref();

  const stop = () => clearInterval(timer);
  ws.on('close', stop);
  ws.on('error', stop);
}
