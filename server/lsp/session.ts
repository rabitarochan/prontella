import type { WebSocket } from 'ws';
import { metrics } from '../metrics/index.js';
import type { JsonRpcMessage, LspHost, ProcHandle, ProcListener } from './host.js';
import { rewriteUris, uriToWire, wireToUri } from './uri.js';

/**
 * 1 WebSocket = 1 セッション。ワイヤーは素の JSON-RPC (LSP) — 独自エンベロープにしない
 * (monaco-languageclient へ切り替えるとき server/lsp/* をそのまま使うため)。
 *
 * セッション層の仕事:
 * - メソッドの allowlist (クライアントは任意の JSON-RPC を投げられる)
 * - URI の書き換え (両方向)。クライアントには実パスを出さない
 * - doc の所有権: 同じファイルを別セッション (別ブラウザータブ) が開いていても LS には 1 ドキュメント。
 *   本文を最後に送った owner だけが didChange を流せる。非 owner の要求は -32803 {prontella:'not-owner'}
 *   で返し、クライアントは全文 didOpen で所有権を取り直してから再要求する
 * - `$/prontella/status` / `$/prontella/reset` の通知 (プロトコル外の拡張は `$/` 接頭辞)
 */

const ALLOWED_REQUESTS = new Set([
  'textDocument/completion',
  'textDocument/hover',
  'textDocument/definition',
  'completionItem/resolve',
]);
const DOC_NOTIFICATIONS = new Set(['textDocument/didOpen', 'textDocument/didChange', 'textDocument/didClose', 'textDocument/didSave']);

export const ERR_METHOD_NOT_FOUND = -32601;
export const ERR_INVALID_PARAMS = -32602;
export const ERR_NOT_OWNER = -32803;

export function attachLsp(ws: WebSocket, root: string, host: LspHost): void {
  metrics.count('lsp.session');
  const send = (msg: JsonRpcMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ jsonrpc: '2.0', ...msg }));
  };
  let handle: ProcHandle | undefined;
  const me: ProcListener = {
    onResponse(msg) {
      send({ ...msg, result: msg.result === undefined ? msg.result : toWire(msg.result) });
    },
    onReset() {
      send({ method: '$/prontella/reset' });
    },
    onStatus(status) {
      // acquire の最中 (handle 未代入) に届く分は、直後に送る hello が最新の status を運ぶ
      if (!handle) return;
      send({ method: '$/prontella/status', params: { rootToken: handle.rootToken, ...status } });
    },
  };
  handle = host.acquire(root, 'typescript', me);
  const h: ProcHandle = handle;
  const toWire = (value: unknown) => rewriteUris(value, (u) => uriToWire(h.root, h.rootToken, h.ext, u));
  // 解釈できない URI が 1 つでもあれば要求ごと拒否する (黙って落とすと LS に空文字が渡る)
  const fromWire = (value: unknown): { ok: true; value: unknown } | { ok: false } => {
    let bad = false;
    const out = rewriteUris(value, (u) => {
      const disk = wireToUri(h.root, h.rootToken, h.ext, u);
      if (disk === null) bad = true;
      return disk;
    });
    return bad ? { ok: false } : { ok: true, value: out };
  };
  send({ method: '$/prontella/status', params: { rootToken: h.rootToken, ...h.status } });

  ws.on('message', (raw) => {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || 'type' in msg) return; // keepAlive の ping 等
    const { id, method } = msg;
    if (typeof method !== 'string') return;
    const reply = (body: Pick<JsonRpcMessage, 'result' | 'error'>) => {
      if (id !== undefined) send({ id, ...body });
    };

    if (method === 'initialize') return reply({ result: { capabilities: h.capabilities ?? {} } });
    if (method === 'initialized' || method === 'exit') return;
    if (method === 'shutdown') return reply({ result: null });
    if (method === '$/prontella/restart') return h.restart();
    if (method === '$/cancelRequest') {
      const target = (msg.params as { id?: number | string } | undefined)?.id;
      if (target !== undefined) h.cancel(me, target);
      return;
    }

    if (DOC_NOTIFICATIONS.has(method)) {
      const p = fromWire(msg.params);
      if (!p.ok) return;
      h.wake();
      onDocNotification(method, p.value as DocParams);
      return;
    }
    if (!ALLOWED_REQUESTS.has(method)) {
      return reply({ error: { code: ERR_METHOD_NOT_FOUND, message: `Method not found: ${method}` } });
    }
    if (id === undefined) return;
    const p = fromWire(msg.params);
    if (!p.ok) return reply({ error: { code: ERR_INVALID_PARAMS, message: '解釈できない URI が含まれています' } });
    const uri = (p.value as DocParams | undefined)?.textDocument?.uri;
    if (uri !== undefined) {
      const doc = h.docs.get(uri);
      if (!doc || !doc.holders.has(me)) return reply({ result: null }); // LS が知らない doc (再起動直後など)
      if (doc.owner !== me) {
        return reply({ error: { code: ERR_NOT_OWNER, message: '別のセッションが本文を更新しています', data: { prontella: 'not-owner' } } });
      }
    }
    h.wake();
    h.request(me, { id, method, params: p.value });
  });

  interface DocParams {
    textDocument?: { uri?: string; languageId?: string; version?: number; text?: string };
    contentChanges?: unknown[];
    text?: string;
  }

  function onDocNotification(method: string, params: DocParams): void {
    const uri = params.textDocument?.uri;
    if (typeof uri !== 'string') return;
    const doc = h.docs.get(uri);
    switch (method) {
      case 'textDocument/didOpen': {
        if (!doc) {
          h.docs.set(uri, { holders: new Set([me]), owner: me });
          h.notify({ method, params });
        } else {
          // 既に LS が知っている → 全文 didChange で本文を差し替え、所有権を取る
          doc.holders.add(me);
          doc.owner = me;
          h.notify({
            method: 'textDocument/didChange',
            params: { textDocument: { uri, version: params.textDocument?.version ?? 0 }, contentChanges: [{ text: params.textDocument?.text ?? '' }] },
          });
        }
        return;
      }
      case 'textDocument/didChange':
        if (doc && doc.owner === me) h.notify({ method, params });
        return;
      case 'textDocument/didClose':
        closeDoc(uri);
        return;
      case 'textDocument/didSave':
        if (doc && doc.holders.has(me)) h.notify({ method, params });
        return;
    }
  }

  function closeDoc(uri: string): void {
    const doc = h.docs.get(uri);
    if (!doc || !doc.holders.has(me)) return;
    doc.holders.delete(me);
    if (doc.holders.size === 0) {
      h.docs.delete(uri);
      h.notify({ method: 'textDocument/didClose', params: { textDocument: { uri } } });
    } else if (doc.owner === me) {
      doc.owner = null; // 残った側は次の要求で not-owner を受け、全文で取り直す
    }
  }

  const cleanup = () => {
    for (const uri of [...h.docs.keys()]) closeDoc(uri);
    h.release(me);
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
}
