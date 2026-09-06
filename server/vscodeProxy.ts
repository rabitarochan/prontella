// VSCodium reh-web への HTTP / WebSocket プロキシ。
//
// なぜプロキシするのか (直接 iframe にしない理由):
//  1. ユーザー設定は workbench のオリジン単位の IndexedDB に入る。動的ポートへ直接
//     iframe を張ると、再起動でポートが変わるたびに設定と拡張機能の状態が消える。
//     Prontella のオリジン配下に載せれば固定される。
//  2. MS の `code serve-web` は全レスポンスに frame-ancestors 'self' と
//     X-Frame-Options: SAMEORIGIN を無条件で付ける (VS Code 1.136.0 以降)。
//     段階 5 でそちらをバックエンドに選べるようにするなら、同一オリジン化が必須になる。
//
// 実装上の急所 — **元の Host ヘッダーを書き換えないこと**:
//   workbench の CSP と remoteAuthority は、リクエストの Host をそのまま反映する。
//   実測:
//     Host: localhost:3711 →  "remoteAuthority":"localhost:3711"  script-src ... http://localhost:3711
//   127.0.0.1:<port> に書き換えて転送すると、ブラウザー (localhost:3711 オリジン) では
//   script-src が一致せず **スクリプトが CSP で全部ブロックされる**。
//   素通しさえすれば remoteAuthority も正しくなり、WS もプロキシ経由に張られる。
import http from 'node:http';
import type net from 'node:net';
import type { Duplex } from 'node:stream';
import type express from 'express';
import { vscodeWeb } from './vscodeWeb.js';

/** HTTP 側。未起動なら 503 を返し、クライアントに ensure させる。 */
export function vscodeProxyHandler(req: express.Request, res: express.Response): void {
  const port = vscodeWeb.activePort();
  if (port === null) {
    res.status(503).json({ error: 'VS Code サーバーが起動していません' });
    return;
  }
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port,
      method: req.method,
      path: req.originalUrl,
      // Host を含めてそのまま渡す (上のコメント参照)
      headers: req.headers,
    },
    (proxyRes) => {
      // Set-Cookie は配列で来る。writeHead に headers オブジェクトごと渡せば
      // 配列のまま複数行として出る — 1 本に潰すと workbench の認証が壊れる。
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.status(502).json({ error: `VS Code サーバーへ接続できません: ${err.message}` });
  });
  req.pipe(upstream);
}

/**
 * WebSocket 側。ws ライブラリー (wss.handleUpgrade) には通さない。
 * workbench のリモート接続はサブプロトコルと拡張のネゴシエーションを自前で行うため、
 * 途中で ws にデコードさせるとフレームが壊れる。生ソケットのまま中継する。
 */
export function vscodeProxyUpgrade(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  const port = vscodeWeb.activePort();
  if (port === null) {
    socket.destroy();
    return;
  }
  const upstream = http.request({
    host: '127.0.0.1',
    port,
    method: req.method,
    path: req.url,
    headers: req.headers,
  });

  upstream.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    // 101 の応答行とヘッダーを組み立て直してクライアントへ返す。
    // rawHeaders を使うのは、Sec-WebSocket-* の大文字小文字と重複を保つため。
    const lines = ['HTTP/1.1 101 Switching Protocols'];
    for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
      lines.push(`${proxyRes.rawHeaders[i]}: ${proxyRes.rawHeaders[i + 1]}`);
    }
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);

    if (proxyHead?.length) proxySocket.unshift(proxyHead);
    proxySocket.on('error', () => socket.destroy());
    socket.on('error', () => proxySocket.destroy());
    // Nagle を切る。ターミナルや補完のような小さいフレームの往復が遅くなる。
    // upgrade の socket は型上 Duplex だが実体は net.Socket
    proxySocket.setNoDelay(true);
    (socket as Partial<net.Socket>).setNoDelay?.(true);
    proxySocket.pipe(socket).pipe(proxySocket);
  });

  upstream.on('error', () => socket.destroy());

  // head はクライアントから既に読まれてしまったバイト列。捨てずに戻す
  if (head?.length) socket.unshift(head);
  upstream.end();
}
