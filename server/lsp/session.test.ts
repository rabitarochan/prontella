import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import type { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { createMessageReader, encodeMessage } from './framing.js';
import { LspHost, answerServerRequest, type JsonRpcMessage } from './host.js';
import { ERR_INVALID_PARAMS, ERR_METHOD_NOT_FOUND, ERR_NOT_OWNER, attachLsp } from './session.js';

// 偽の言語サーバー: stdin のフレームを解釈し、initialize には capabilities を、それ以外の要求には
// {echo: method, params} を返す。
class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 4242;
  received: JsonRpcMessage[] = [];
  initCaps: Record<string, unknown> = { positionEncoding: 'utf-16', completionProvider: { triggerCharacters: ['.'] } };
  constructor() {
    super();
    const reader = createMessageReader(
      (m) => {
        const msg = m as JsonRpcMessage;
        this.received.push(msg);
        if (msg.id !== undefined && msg.method === 'initialize') this.reply({ id: msg.id, result: { capabilities: this.initCaps } });
        else if (msg.id !== undefined && msg.method === 'shutdown') this.reply({ id: msg.id, result: null });
        else if (msg.id !== undefined && msg.method) this.reply({ id: msg.id, result: { echo: msg.method, params: msg.params } });
      },
      (e) => {
        throw e;
      },
    );
    this.stdin.on('data', (c: Buffer) => reader.push(c));
  }
  reply(msg: JsonRpcMessage): void {
    this.stdout.write(encodeMessage({ jsonrpc: '2.0', ...msg }));
  }
  kill(): boolean {
    this.emit('exit', null, 'SIGTERM');
    return true;
  }
  /** 予期しない終了 */
  crash(): void {
    this.emit('exit', 1, null);
  }
}

class FakeWs extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  sent: JsonRpcMessage[] = [];
  send(s: string): void {
    this.sent.push(JSON.parse(s));
  }
  close(): void {
    this.readyState = 3;
    this.emit('close');
  }
  /** クライアント → サーバー */
  push(msg: JsonRpcMessage): void {
    this.emit('message', Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg })));
  }
  last(): JsonRpcMessage {
    return this.sent[this.sent.length - 1]!;
  }
  find(pred: (m: JsonRpcMessage) => boolean): JsonRpcMessage | undefined {
    return this.sent.find(pred);
  }
}

const tick = () => new Promise<void>((r) => setImmediate(r));
async function settle() {
  for (let i = 0; i < 5; i++) await tick();
}

const root = process.cwd();
const diskUri = (rel: string) => pathToFileURL(path.join(root, rel)).href;

function setup() {
  const children: FakeChild[] = [];
  const host = new LspHost({
    configFor: () => ({ mode: 'lsp' }),
    resolve: () => ({ command: 'fake', args: [], source: 'config' }),
    env: () => ({}),
    spawn: (() => {
      const c = new FakeChild();
      children.push(c);
      return c;
    }) as never,
  });
  const connect = () => {
    const ws = new FakeWs();
    attachLsp(ws as unknown as WebSocket, root, host);
    return ws;
  };
  return { host, children, connect, child: () => children[children.length - 1]! };
}

const sockets: FakeWs[] = [];
afterEach(() => {
  for (const ws of sockets.splice(0)) if (ws.readyState === 1) ws.close();
});

describe('attachLsp', () => {
  it('接続直後に rootToken 付きの status を送り、initialize 後に ready になる', async () => {
    const { connect } = setup();
    const ws = connect();
    sockets.push(ws);
    const hello = ws.sent[0]!;
    expect(hello.method).toBe('$/prontella/status');
    const token = (hello.params as { rootToken: string }).rootToken;
    expect(token).toMatch(/^r[0-9a-f]{8}$/);
    await settle();
    expect(ws.find((m) => m.method === '$/prontella/status' && (m.params as { state: string }).state === 'ready')).toBeTruthy();
  });

  it('要求 id を子プロセス側で振り直し、応答は元の id で返る。URI は両方向で書き換わる', async () => {
    const { connect, child } = setup();
    const ws = connect();
    sockets.push(ws);
    await settle();
    const token = (ws.sent[0]!.params as { rootToken: string }).rootToken;
    ws.push({ method: 'textDocument/didOpen', params: { textDocument: { uri: `file:///${token}/src/a.ts`, languageId: 'typescript', version: 1, text: 'x' } } });
    ws.push({ id: 'abc', method: 'textDocument/completion', params: { textDocument: { uri: `file:///${token}/src/a.ts` }, position: { line: 0, character: 1 } } });
    await settle();
    const fwd = child().received.find((m) => m.method === 'textDocument/completion')!;
    expect(typeof fwd.id).toBe('number');
    expect((fwd.params as { textDocument: { uri: string } }).textDocument.uri).toBe(diskUri('src/a.ts'));
    const res = ws.find((m) => m.id === 'abc')!;
    expect((res.result as { params: { textDocument: { uri: string } } }).params.textDocument.uri).toBe(`file:///${token}/src/a.ts`);
  });

  it('allowlist 外のメソッドは -32601、解釈できない URI は -32602、未知の doc は null', async () => {
    const { connect } = setup();
    const ws = connect();
    sockets.push(ws);
    await settle();
    const token = (ws.sent[0]!.params as { rootToken: string }).rootToken;
    ws.push({ id: 1, method: 'textDocument/rename', params: {} });
    expect(ws.last()).toMatchObject({ id: 1, error: { code: ERR_METHOD_NOT_FOUND } });
    ws.push({ id: 2, method: 'textDocument/hover', params: { textDocument: { uri: 'file:///C:/etc/passwd' } } });
    expect(ws.last()).toMatchObject({ id: 2, error: { code: ERR_INVALID_PARAMS } });
    ws.push({ id: 3, method: 'textDocument/hover', params: { textDocument: { uri: `file:///${token}/never-opened.ts` } } });
    expect(ws.last()).toMatchObject({ id: 3, result: null });
  });

  it('別セッションの重複 didOpen は全文 didChange になり、所有権が移る (非 owner の要求は -32803)', async () => {
    const { connect, child } = setup();
    const a = connect();
    const b = connect();
    sockets.push(a, b);
    await settle();
    const token = (a.sent[0]!.params as { rootToken: string }).rootToken;
    const uri = `file:///${token}/src/a.ts`;
    a.push({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'typescript', version: 1, text: 'A' } } });
    b.push({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'typescript', version: 7, text: 'B' } } });
    await settle();
    const opens = child().received.filter((m) => m.method === 'textDocument/didOpen');
    const changes = child().received.filter((m) => m.method === 'textDocument/didChange');
    expect(opens).toHaveLength(1);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.params).toEqual({ textDocument: { uri: diskUri('src/a.ts'), version: 7 }, contentChanges: [{ text: 'B' }] });

    // a は owner ではない → -32803。a の didChange は流れない
    a.push({ method: 'textDocument/didChange', params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: 'A2' }] } });
    a.push({ id: 10, method: 'textDocument/completion', params: { textDocument: { uri }, position: { line: 0, character: 0 } } });
    await settle();
    expect(a.last()).toMatchObject({ id: 10, error: { code: ERR_NOT_OWNER, data: { prontella: 'not-owner' } } });
    expect(child().received.filter((m) => m.method === 'textDocument/didChange')).toHaveLength(1);

    // a が全文 didOpen で取り直す → 通る
    a.push({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'typescript', version: 3, text: 'A3' } } });
    a.push({ id: 11, method: 'textDocument/completion', params: { textDocument: { uri }, position: { line: 0, character: 0 } } });
    await settle();
    expect(a.last()).toMatchObject({ id: 11, result: { echo: 'textDocument/completion' } });

    // b が閉じても a が持っているので LS には didClose を送らない。a が閉じたら送る
    b.push({ method: 'textDocument/didClose', params: { textDocument: { uri } } });
    expect(child().received.filter((m) => m.method === 'textDocument/didClose')).toHaveLength(0);
    a.close();
    expect(child().received.filter((m) => m.method === 'textDocument/didClose')).toHaveLength(1);
  });

  it('initialize 前の didOpen は ready 後に順序どおり流れる', async () => {
    const { connect, child } = setup();
    const ws = connect();
    sockets.push(ws);
    const token = (ws.sent[0]!.params as { rootToken: string }).rootToken;
    ws.push({ method: 'textDocument/didOpen', params: { textDocument: { uri: `file:///${token}/a.ts`, languageId: 'typescript', version: 1, text: '' } } });
    expect(child().received.map((m) => m.method)).toEqual(['initialize']);
    await settle();
    expect(child().received.map((m) => m.method)).toEqual(['initialize', 'initialized', 'textDocument/didOpen']);
  });

  it('クラッシュで reset が届き、pending は null で解決し、60 秒に 3 回で unavailable', async () => {
    const { connect, child, children } = setup();
    const ws = connect();
    sockets.push(ws);
    await settle();
    const token = (ws.sent[0]!.params as { rootToken: string }).rootToken;
    const uri = `file:///${token}/a.ts`;
    ws.push({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'typescript', version: 1, text: '' } } });
    // 応答を返さない偽サーバーにして pending を作る
    child().reply = () => {};
    ws.push({ id: 5, method: 'textDocument/hover', params: { textDocument: { uri }, position: { line: 0, character: 0 } } });
    await settle();
    child().crash();
    expect(ws.find((m) => m.id === 5)).toMatchObject({ id: 5, result: null });
    expect(ws.find((m) => m.method === '$/prontella/reset')).toBeTruthy();
    // 再起動は次の要求で。doc は忘れられているので null
    ws.push({ id: 6, method: 'textDocument/hover', params: { textDocument: { uri }, position: { line: 0, character: 0 } } });
    expect(ws.last()).toMatchObject({ id: 6, result: null });
    ws.push({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'typescript', version: 1, text: '' } } });
    await settle();
    expect(children).toHaveLength(2);
    child().crash();
    ws.push({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'typescript', version: 1, text: '' } } });
    await settle();
    expect(children).toHaveLength(3);
    child().crash();
    expect(ws.find((m) => (m.params as { state?: string } | undefined)?.state === 'unavailable')).toBeTruthy();
    ws.push({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'typescript', version: 1, text: '' } } });
    await settle();
    expect(children).toHaveLength(3); // もう起動しない
    ws.push({ method: '$/prontella/restart' });
    await settle();
    expect(children).toHaveLength(4); // 明示の再起動で解除
  });

  it('positionEncoding が utf-16 以外のサーバーは使わない', async () => {
    const host2 = new LspHost({
      configFor: () => ({ mode: 'lsp' }),
      resolve: () => ({ command: 'fake', args: [], source: 'config' }),
      env: () => ({}),
      spawn: (() => {
        const c = new FakeChild();
        c.initCaps = { positionEncoding: 'utf-8' };
        return c;
      }) as never,
    });
    const ws2 = new FakeWs();
    sockets.push(ws2);
    attachLsp(ws2 as unknown as WebSocket, root, host2);
    await settle();
    expect(ws2.find((m) => (m.params as { state?: string } | undefined)?.state === 'unavailable')).toBeTruthy();
    expect(ws2.find((m) => (m.params as { state?: string } | undefined)?.state === 'ready')).toBeUndefined();
  });
});

describe('answerServerRequest', () => {
  it('既知のサーバー→クライアント要求は null、configuration は項目数ぶんの null、未知は -32601', () => {
    expect(answerServerRequest({ method: 'client/registerCapability' })).toEqual({ result: null });
    expect(answerServerRequest({ method: 'window/workDoneProgress/create' })).toEqual({ result: null });
    expect(answerServerRequest({ method: 'workspace/configuration', params: { items: [{}, {}] } })).toEqual({ result: [null, null] });
    expect(answerServerRequest({ method: 'window/showMessageRequest' })).toMatchObject({ error: { code: -32601 } });
  });
});
