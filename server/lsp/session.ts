import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebSocket } from 'ws';
import { metrics } from '../metrics/index.js';
import type { JsonRpcMessage, LspHost, ProcHandle, ProcListener } from './host.js';
import { findSolution, fsListDir, type ServerId } from './registry.js';
import { createExtTable, rewriteUris, uriToWire, wireToUri } from './uri.js';

/**
 * 1 WebSocket = 1 セッション = (root, serverId)。ワイヤーは素の JSON-RPC (LSP) — 独自エンベロープにしない
 * (monaco-languageclient へ切り替えるとき server/lsp/* をそのまま使うため)。
 *
 * セッション層の仕事:
 * - メソッドの allowlist (クライアントは任意の JSON-RPC を投げられる)
 * - URI の書き換え (両方向)。クライアントには実パスを出さない
 * - doc の所有権: 同じファイルを別セッション (別ブラウザータブ) が開いていても LS には 1 ドキュメント。
 *   本文を最後に送った owner だけが didChange を流せる。非 owner の要求は -32803 {prontella:'not-owner'}
 *   で返し、クライアントは全文 didOpen で所有権を取り直してから再要求する
 * - プロセスへの振り分け: TS は root に 1 つ。C# は Roslyn LS が 1 プロセス 1 ソリューションなので、
 *   doc の最寄り .sln ごとにプロセスを持ち、要求は textDocument.uri で振り分ける
 *   (`completionItem/resolve` は URI を持たないので直前に completion を返したプロセスへ)
 * - `$/prontella/status` / `$/prontella/reset` の通知 (プロトコル外の拡張は `$/` 接頭辞)
 * - range 無しの全文 didChange は **didClose → didOpen に変換**する。Roslyn は全文 didChange で
 *   NullReferenceException を起こして落ちる (RESULTS.md フェーズ 2 D5)。所有権の移譲 (既知 doc への didOpen)
 *   とクライアントの isFlush / isEolChange の両経路がここを通るので、ここ 1 箇所で直す
 */

const ALLOWED_REQUESTS = new Set([
  'textDocument/completion',
  'textDocument/hover',
  'textDocument/definition',
  'completionItem/resolve',
  'textDocument/diagnostic',
  'textDocument/signatureHelp',
  'textDocument/references',
  'workspace/symbol',
]);
/** C# は 1 ソリューション 1 プロセスなので、workspace/symbol は全プロセスに投げて結果を連結する */
const FAN_OUT_TIMEOUT_MS = 15_000;
/** `$/prontella/readExternal` の上限。lib.dom.d.ts (2.3MB) が入る */
export const MAX_EXTERNAL_SIZE = 4 * 1024 * 1024;
const DOC_NOTIFICATIONS = new Set(['textDocument/didOpen', 'textDocument/didChange', 'textDocument/didClose', 'textDocument/didSave']);

export const ERR_METHOD_NOT_FOUND = -32601;
export const ERR_INVALID_PARAMS = -32602;
export const ERR_NOT_OWNER = -32803;

interface DocParams {
  textDocument?: { uri?: string; languageId?: string; version?: number; text?: string };
  contentChanges?: Array<{ range?: unknown; text?: string }>;
  text?: string;
}

interface Slot {
  handle: ProcHandle;
  listener: ProcListener;
}

export function attachLsp(ws: WebSocket, root: string, host: LspHost, serverId: ServerId = 'typescript', listDir = fsListDir): void {
  metrics.count('lsp.session');
  const rootAbs = path.resolve(root);
  const rootToken = host.tokenFor(root);
  const send = (msg: JsonRpcMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ jsonrpc: '2.0', ...msg }));
  };
  // ワークスペースキー ('' = ソリューション無し / TS) → プロセス
  const slots = new Map<string, Slot>();
  const solutionByDir = new Map<string, string | null>();
  let lastCompletion: Slot | null = null;
  // lsp.csharp.solution: 設定があれば全 doc をそのソリューションのプロセスへ (.sln が見つからない doc にも効く)
  const configuredSolution = serverId === 'csharp' ? host.configFor('csharp').solution : undefined;
  const fixedSolution = configuredSolution ? path.resolve(rootAbs, configuredSolution) : undefined;

  // 解釈できない URI が 1 つでもあれば要求ごと拒否する (黙って落とすと LS に空文字が渡る)。
  // クライアントは -ext URI を送ってこないので ext 表は空でよい
  const incomingExt = createExtTable();
  const fromWire = (value: unknown): { ok: true; value: unknown } | { ok: false } => {
    let bad = false;
    const out = rewriteUris(value, (u) => {
      const disk = wireToUri(rootAbs, rootToken, incomingExt, u);
      if (disk === null) bad = true;
      return disk;
    });
    return bad ? { ok: false } : { ok: true, value: out };
  };

  /** 何かのプロセスが ready なら ready (別ソリューションの起動中に既存の補完を止めない) */
  const anyReady = () => [...slots.values()].some((s) => s.handle.status.state === 'ready');

  function acquire(key: string, solution?: string): Slot {
    const existing = slots.get(key);
    if (existing) return existing;
    const slot: Partial<Slot> = {};
    const listener: ProcListener = {
      onResponse(msg) {
        const h = slot.handle!;
        send({ ...msg, result: msg.result === undefined ? msg.result : rewriteUris(msg.result, (u) => uriToWire(h.root, rootToken, h.ext, u)) });
      },
      onReset() {
        send({ method: '$/prontella/reset' });
      },
      onStatus(status) {
        if (!slot.handle) return; // acquire の最中 (handle 未代入) の分は直後の hello が運ぶ
        send({ method: '$/prontella/status', params: { rootToken, ...status, state: status.state !== 'ready' && anyReady() ? 'ready' : status.state } });
      },
    };
    slot.listener = listener;
    slot.handle = host.acquire(root, serverId, listener, solution !== undefined || key !== '' ? { key, solution } : undefined);
    const done = slot as Slot;
    slots.set(key, done);
    send({ method: '$/prontella/status', params: { rootToken, ...done.handle.status } });
    return done;
  }

  /** doc の宛先プロセス。C# は最寄りの .sln 単位、TS は root に 1 つ */
  function slotFor(diskUri: string): Slot {
    if (serverId !== 'csharp') return acquire('');
    if (fixedSolution !== undefined) return acquire(process.platform === 'win32' ? fixedSolution.toLowerCase() : fixedSolution, fixedSolution);
    let abs: string;
    try {
      abs = fileURLToPath(diskUri);
    } catch {
      return acquire('');
    }
    const dir = path.dirname(abs);
    let sln = solutionByDir.get(dir);
    if (sln === undefined) {
      sln = findSolution(rootAbs, abs, listDir);
      solutionByDir.set(dir, sln);
    }
    if (sln === null) return acquire('');
    const key = process.platform === 'win32' ? sln.toLowerCase() : sln;
    return acquire(key, sln);
  }

  if (serverId !== 'csharp') acquire('');
  else send({ method: '$/prontella/status', params: { rootToken, state: 'stopped' } });

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

    if (method === 'initialize') {
      const first = slots.values().next().value as Slot | undefined;
      return reply({ result: { capabilities: first?.handle.capabilities ?? {} } });
    }
    if (method === 'initialized' || method === 'exit') return;
    if (method === 'shutdown') return reply({ result: null });
    if (method === '$/prontella/restart') {
      for (const s of slots.values()) s.handle.restart();
      return;
    }
    if (method === '$/cancelRequest') {
      const target = (msg.params as { id?: number | string } | undefined)?.id;
      if (target !== undefined) for (const s of slots.values()) s.handle.cancel(s.listener, target);
      return;
    }
    if (method === '$/prontella/readExternal') {
      if (id === undefined) return;
      const wire = (msg.params as { uri?: unknown } | undefined)?.uri;
      return reply({ result: typeof wire === 'string' ? readExternal(wire) : null });
    }

    if (DOC_NOTIFICATIONS.has(method)) {
      const p = fromWire(msg.params);
      if (!p.ok) return;
      const params = p.value as DocParams;
      const uri = params.textDocument?.uri;
      if (typeof uri !== 'string') return;
      const slot = slotFor(uri);
      slot.handle.wake();
      onDocNotification(slot, method, uri, params);
      return;
    }
    if (!ALLOWED_REQUESTS.has(method)) {
      return reply({ error: { code: ERR_METHOD_NOT_FOUND, message: `Method not found: ${method}` } });
    }
    if (id === undefined) return;
    const p = fromWire(msg.params);
    if (!p.ok) return reply({ error: { code: ERR_INVALID_PARAMS, message: '解釈できない URI が含まれています' } });
    if (method === 'workspace/symbol') return fanOut(id, method, p.value);
    const uri = (p.value as DocParams | undefined)?.textDocument?.uri;
    let slot: Slot | undefined;
    if (uri !== undefined) {
      slot = slotFor(uri);
      const doc = slot.handle.docs.get(uri);
      if (!doc || !doc.holders.has(slot.listener)) return reply({ result: null }); // LS が知らない doc (再起動直後など)
      if (doc.owner !== slot.listener) {
        return reply({ error: { code: ERR_NOT_OWNER, message: '別のセッションが本文を更新しています', data: { prontella: 'not-owner' } } });
      }
      if (method === 'textDocument/completion') lastCompletion = slot;
    } else {
      slot = lastCompletion ?? slots.values().next().value;
      if (!slot) return reply({ result: null });
    }
    slot.handle.wake();
    slot.handle.request(slot.listener, { id, method, params: p.value });
  });

  function onDocNotification(slot: Slot, method: string, uri: string, params: DocParams): void {
    const { handle: h, listener: me } = slot;
    const doc = h.docs.get(uri);
    const open = (languageId: string, version: number, text: string) => {
      h.notify({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId, version, text } } });
      if (serverId === 'csharp') h.warm(uri);
    };
    switch (method) {
      case 'textDocument/didOpen': {
        const languageId = params.textDocument?.languageId ?? doc?.languageId ?? 'plaintext';
        if (!doc) {
          h.docs.set(uri, { holders: new Set([me]), owner: me, languageId });
          open(languageId, params.textDocument?.version ?? 0, params.textDocument?.text ?? '');
        } else {
          // 既に LS が知っている → 閉じて開き直し、本文を差し替えて所有権を取る
          doc.holders.add(me);
          doc.owner = me;
          h.notify({ method: 'textDocument/didClose', params: { textDocument: { uri } } });
          open(doc.languageId, params.textDocument?.version ?? 0, params.textDocument?.text ?? '');
        }
        return;
      }
      case 'textDocument/didChange': {
        if (!doc || doc.owner !== me) return;
        const full = [...(params.contentChanges ?? [])].reverse().find((c) => c && typeof c === 'object' && c.range === undefined);
        if (full) {
          h.notify({ method: 'textDocument/didClose', params: { textDocument: { uri } } });
          open(doc.languageId, params.textDocument?.version ?? 0, full.text ?? '');
        } else {
          h.notify({ method, params });
        }
        return;
      }
      case 'textDocument/didClose':
        closeDoc(slot, uri);
        return;
      case 'textDocument/didSave':
        if (doc && doc.holders.has(me)) h.notify({ method, params });
        return;
    }
  }

  function closeDoc(slot: Slot, uri: string): void {
    const { handle: h, listener: me } = slot;
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

  /**
   * doc を持たない要求 (workspace/symbol) を全プロセスへ送り、配列の結果を連結して 1 つの応答にする。
   * 応答が揃うまで待つが、1 つでも失敗/タイムアウトしたら揃った分だけ返す (空ではなく部分結果)。
   */
  function fanOut(id: number | string, method: string, params: unknown): void {
    const targets = [...slots.values()].filter((s) => s.handle.status.state === 'ready' || s.handle.status.state === 'starting');
    if (targets.length === 0) return send({ id, result: [] });
    const results: unknown[][] = [];
    let remaining = targets.length;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      send({ id, result: results.flat() });
    };
    const timer = setTimeout(finish, FAN_OUT_TIMEOUT_MS);
    for (const slot of targets) {
      const collector: ProcListener = {
        onResponse(msg) {
          if (Array.isArray(msg.result)) results.push(rewriteUris(msg.result, (u) => uriToWire(slot.handle.root, rootToken, slot.handle.ext, u)) as unknown[]);
          if (--remaining === 0) finish();
        },
        onReset() {},
        onStatus() {},
      };
      slot.handle.wake();
      slot.handle.request(collector, { id, method, params });
    }
  }

  /**
   * root 外 (`-ext`) または root 内で `/api/fs` の上限を超えるファイルを読み取り専用ビューアー向けに読む。
   * `-ext` の opaque id は各プロセスの ExtTable からしか引けない (絶対パスは受け取らない)。
   */
  function readExternal(wire: string): { name: string; text: string } | null {
    let abs: string | null = null;
    for (const s of slots.values()) {
      const disk = wireToUri(rootAbs, rootToken, s.handle.ext, wire);
      if (disk !== null) {
        try {
          abs = fileURLToPath(disk);
        } catch {
          return null;
        }
        break;
      }
    }
    if (abs === null) return null;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > MAX_EXTERNAL_SIZE) return null;
      return { name: path.basename(abs), text: fs.readFileSync(abs, 'utf8') };
    } catch {
      return null;
    }
  }

  const cleanup = () => {
    for (const slot of slots.values()) {
      for (const uri of [...slot.handle.docs.keys()]) closeDoc(slot, uri);
      slot.handle.release(slot.listener);
    }
    slots.clear();
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
}
