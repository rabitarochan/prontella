import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import type { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { createMessageReader, encodeMessage } from './framing.js';
import { LspHost, answerServerRequest, globToAbsolute, matchesGlobs, type JsonRpcMessage } from './host.js';
import { ERR_INVALID_PARAMS, ERR_METHOD_NOT_FOUND, ERR_NOT_OWNER, MAX_EXTERNAL_SIZE, attachLsp } from './session.js';
import type { LspServerConfig, ServerId } from './registry.js';

// 偽の言語サーバー: stdin のフレームを解釈し、initialize には capabilities を、それ以外の要求には
// {echo: method, params} を返す。
class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 4242;
  received: JsonRpcMessage[] = [];
  /** 温めの diagnostic への応答は手動で返す (保留の検証用)。answerDiagnostics() で流す */
  diagnostics: Array<() => void> = [];
  answerDiagnostics(): void {
    for (const f of this.diagnostics.splice(0)) f();
  }
  initCaps: Record<string, unknown> = { positionEncoding: 'utf-16', completionProvider: { triggerCharacters: ['.'] } };
  constructor() {
    super();
    const reader = createMessageReader(
      (m) => {
        const msg = m as JsonRpcMessage;
        this.received.push(msg);
        if (msg.id !== undefined && msg.method === 'initialize') this.reply({ id: msg.id, result: { capabilities: this.initCaps } });
        else if (msg.id !== undefined && msg.method === 'shutdown') this.reply({ id: msg.id, result: null });
        else if (msg.id !== undefined && msg.method === 'textDocument/diagnostic') this.diagnostics.push(() => this.reply({ id: msg.id, result: { items: [] } }));
        else if (msg.id !== undefined && msg.method) this.reply({ id: msg.id, result: { echo: msg.method, params: msg.params } });
        // Roslyn: solution/open のあとでプロジェクト読込完了を通知する
        else if (msg.method === 'solution/open') this.reply({ method: 'workspace/projectInitializationComplete', params: {} });
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

function setup(config: LspServerConfig = { mode: 'lsp' }) {
  const children: FakeChild[] = [];
  /** 偽の fs.watch: テストがイベントを注入する */
  const watchers: Array<{ root: string; onEvent: (e: string, f: string | null) => void; closed: boolean }> = [];
  const host = new LspHost({
    configFor: () => config,
    resolve: () => ({ command: 'fake', args: [], source: 'config' }),
    env: () => ({}),
    spawn: (() => {
      const c = new FakeChild();
      children.push(c);
      return c;
    }) as never,
    watch: (root, onEvent) => {
      const w = { root, onEvent, closed: false };
      watchers.push(w);
      return { close: () => (w.closed = true) };
    },
  });
  const connect = (serverId: ServerId = 'typescript', listDir?: (abs: string) => string[]) => {
    const ws = new FakeWs();
    attachLsp(ws as unknown as WebSocket, root, host, serverId, listDir);
    return ws;
  };
  return { host, children, watchers, connect, child: () => children[children.length - 1]! };
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

  it('別セッションの重複 didOpen は didClose + didOpen になり、所有権が移る (非 owner の要求は -32803)', async () => {
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
    // Roslyn は全文 didChange で落ちる (RESULTS.md フェーズ 2 D5) ので、閉じて開き直す
    expect(child().received.filter((m) => m.method !== 'initialize' && m.method !== 'initialized').map((m) => m.method)).toEqual([
      'textDocument/didOpen',
      'textDocument/didClose',
      'textDocument/didOpen',
    ]);
    const reopened = child().received.filter((m) => m.method === 'textDocument/didOpen')[1]!;
    expect(reopened.params).toEqual({ textDocument: { uri: diskUri('src/a.ts'), languageId: 'typescript', version: 7, text: 'B' } });

    // a は owner ではない → -32803。a の didChange は流れない
    a.push({ method: 'textDocument/didChange', params: { textDocument: { uri, version: 2 }, contentChanges: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, text: 'A2' }] } });
    a.push({ id: 10, method: 'textDocument/completion', params: { textDocument: { uri }, position: { line: 0, character: 0 } } });
    await settle();
    expect(a.last()).toMatchObject({ id: 10, error: { code: ERR_NOT_OWNER, data: { prontella: 'not-owner' } } });
    expect(child().received.filter((m) => m.method === 'textDocument/didChange')).toHaveLength(0);

    // a が全文 didOpen で取り直す → 通る
    a.push({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'typescript', version: 3, text: 'A3' } } });
    a.push({ id: 11, method: 'textDocument/completion', params: { textDocument: { uri }, position: { line: 0, character: 0 } } });
    await settle();
    expect(a.last()).toMatchObject({ id: 11, result: { echo: 'textDocument/completion' } });

    // b が閉じても a が持っているので LS には didClose を送らない。a が閉じたら送る (2 回の開き直しぶんを除く)
    const closesBefore = child().received.filter((m) => m.method === 'textDocument/didClose').length;
    b.push({ method: 'textDocument/didClose', params: { textDocument: { uri } } });
    expect(child().received.filter((m) => m.method === 'textDocument/didClose')).toHaveLength(closesBefore);
    a.close();
    expect(child().received.filter((m) => m.method === 'textDocument/didClose')).toHaveLength(closesBefore + 1);
  });

  it('range 無しの全文 didChange は didClose + didOpen に変換する (isFlush / isEolChange 経路。Roslyn が落ちるため)', async () => {
    const { connect, child } = setup();
    const ws = connect();
    sockets.push(ws);
    await settle();
    const token = (ws.sent[0]!.params as { rootToken: string }).rootToken;
    const uri = `file:///${token}/src/a.tsx`;
    ws.push({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'typescriptreact', version: 1, text: 'A' } } });
    ws.push({ method: 'textDocument/didChange', params: { textDocument: { uri, version: 2 }, contentChanges: [{ range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } }, text: 'B' }] } });
    ws.push({ method: 'textDocument/didChange', params: { textDocument: { uri, version: 3 }, contentChanges: [{ text: 'C' }] } });
    await settle();
    const seq = child().received.filter((m) => m.method?.startsWith('textDocument/'));
    expect(seq.map((m) => m.method)).toEqual(['textDocument/didOpen', 'textDocument/didChange', 'textDocument/didClose', 'textDocument/didOpen']);
    // 開き直しの languageId は最初の didOpen のもの (tsgo は最初の languageId で固定する)
    expect(seq[3]!.params).toEqual({ textDocument: { uri: diskUri('src/a.tsx'), languageId: 'typescriptreact', version: 3, text: 'C' } });
    expect(child().received.filter((m) => m.method === 'textDocument/didChange')).toHaveLength(1);
  });

  it('diagnostic / signatureHelp / references は LS へ届き、応答の URI が書き換わる', async () => {
    const { connect, child } = setup();
    const ws = connect();
    sockets.push(ws);
    await settle();
    const token = (ws.sent[0]!.params as { rootToken: string }).rootToken;
    const uri = `file:///${token}/src/a.ts`;
    ws.push({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'typescript', version: 1, text: '' } } });
    ws.push({ id: 1, method: 'textDocument/diagnostic', params: { textDocument: { uri } } });
    ws.push({ id: 2, method: 'textDocument/signatureHelp', params: { textDocument: { uri }, position: { line: 0, character: 0 }, context: { triggerKind: 1, isRetrigger: false } } });
    // references は Location[] で返る (LS 側の絶対 URI → ワイヤー)
    const orig = child().reply.bind(child());
    child().reply = (m) => orig(m.id !== undefined && (m.result as { echo?: string } | undefined)?.echo === 'textDocument/references' ? { id: m.id, result: [{ uri: diskUri('src/b.ts'), range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } } }] } : m);
    ws.push({ id: 3, method: 'textDocument/references', params: { textDocument: { uri }, position: { line: 0, character: 0 }, context: { includeDeclaration: true } } });
    await settle();
    expect(child().received.map((m) => m.method)).toEqual(expect.arrayContaining(['textDocument/diagnostic', 'textDocument/signatureHelp', 'textDocument/references']));
    child().answerDiagnostics(); // 偽サーバーは diagnostic を手動で返す
    await settle();
    expect(ws.find((m) => m.id === 1)).toMatchObject({ result: { items: [] } });
    expect(ws.find((m) => m.id === 2)).toMatchObject({ result: { echo: 'textDocument/signatureHelp' } });
    expect(ws.find((m) => m.id === 3)).toMatchObject({ result: [{ uri: `file:///${token}/src/b.ts` }] });
  });

  it('$/prontella/readExternal: -ext と root 内の URI を読む。上限超え・未知の id・絶対パスは null', async () => {
    const { connect, child } = setup();
    const ws = connect();
    sockets.push(ws);
    await settle();
    const token = (ws.sent[0]!.params as { rootToken: string }).rootToken;
    const uri = `file:///${token}/src/a.ts`;
    ws.push({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'typescript', version: 1, text: '' } } });
    const dir = fs.mkdtempSync(path.join(root, 'vt', 'lsp-ext-'));
    try {
      const outside = path.join(dir, 'lib.dom.d.ts');
      fs.writeFileSync(outside, 'declare var console: Console;');
      const big = path.join(dir, 'big.d.ts');
      fs.writeFileSync(big, Buffer.alloc(MAX_EXTERNAL_SIZE + 1, 0x61));
      // vt/ は root (cwd) の配下なので、この 2 つは root 内扱いになる。root 外の代表として親ディレクトリーのファイルを使う
      const orig = child().reply.bind(child());
      const targets: Record<string, string> = { '0': outside, '1': big };
      child().reply = (m) => {
        const echo = (m.result as { echo?: string; params?: { position?: { line?: number } } } | undefined);
        if (m.id !== undefined && echo?.echo === 'textDocument/definition') {
          const t = targets[String(echo.params?.position?.line)];
          return orig({ id: m.id, result: { uri: pathToFileURL(t!).href, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } } });
        }
        return orig(m);
      };
      ws.push({ id: 1, method: 'textDocument/definition', params: { textDocument: { uri }, position: { line: 0, character: 0 } } });
      ws.push({ id: 2, method: 'textDocument/definition', params: { textDocument: { uri }, position: { line: 1, character: 0 } } });
      await settle();
      const rel = path.relative(root, outside).split(path.sep).join('/');
      const wireOutside = (ws.find((m) => m.id === 1)!.result as { uri: string }).uri;
      expect(wireOutside).toBe(`file:///${token}/${rel}`);
      ws.push({ id: 3, method: '$/prontella/readExternal', params: { uri: wireOutside } });
      expect(ws.last()).toMatchObject({ id: 3, result: { name: 'lib.dom.d.ts', text: 'declare var console: Console;' } });
      const wireBig = (ws.find((m) => m.id === 2)!.result as { uri: string }).uri;
      ws.push({ id: 4, method: '$/prontella/readExternal', params: { uri: wireBig } });
      expect(ws.last()).toMatchObject({ id: 4, result: null });
      ws.push({ id: 5, method: '$/prontella/readExternal', params: { uri: `file:///${token}-ext/p1e99/x.ts` } });
      expect(ws.last()).toMatchObject({ id: 5, result: null });
      ws.push({ id: 6, method: '$/prontella/readExternal', params: { uri: pathToFileURL(outside).href } });
      expect(ws.last()).toMatchObject({ id: 6, result: null });
      ws.push({ id: 7, method: '$/prontella/readExternal', params: { uri: `file:///${token}/../package.json` } });
      expect(ws.last()).toMatchObject({ id: 7, result: null });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('$/prontella/readExternal: root 外の -ext URI はプロセスの表から引く', async () => {
    const { connect, child } = setup();
    const ws = connect();
    sockets.push(ws);
    await settle();
    const token = (ws.sent[0]!.params as { rootToken: string }).rootToken;
    const uri = `file:///${token}/src/a.ts`;
    ws.push({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'typescript', version: 1, text: '' } } });
    const outside = path.join(root, '..', 'lsp-ext-outside.d.ts');
    fs.writeFileSync(outside, 'export {};');
    try {
      const orig = child().reply.bind(child());
      child().reply = (m) =>
        orig(m.id !== undefined && (m.result as { echo?: string } | undefined)?.echo === 'textDocument/definition' ? { id: m.id, result: { uri: pathToFileURL(outside).href, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } } } : m);
      ws.push({ id: 1, method: 'textDocument/definition', params: { textDocument: { uri }, position: { line: 0, character: 0 } } });
      await settle();
      const wire = (ws.find((m) => m.id === 1)!.result as { uri: string }).uri;
      expect(wire).toMatch(new RegExp(`^file:///${token}-ext/p\\d+e1/lsp-ext-outside\\.d\\.ts$`));
      ws.push({ id: 2, method: '$/prontella/readExternal', params: { uri: wire } });
      expect(ws.last()).toMatchObject({ id: 2, result: { name: 'lsp-ext-outside.d.ts', text: 'export {};' } });
    } finally {
      fs.rmSync(outside, { force: true });
    }
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

  it('unavailable の間に届いた didOpen は、再起動時の reset で開き直される (LS に届かないまま残らない)', async () => {
    const { connect, child, children } = setup();
    const ws = connect();
    sockets.push(ws);
    await settle();
    const token = (ws.sent[0]!.params as { rootToken: string }).rootToken;
    const uri = `file:///${token}/a.ts`;
    for (let i = 0; i < 3; i++) {
      ws.push({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'typescript', version: 1, text: '' } } });
      await settle();
      child().crash();
    }
    expect(ws.find((m) => (m.params as { state?: string } | undefined)?.state === 'unavailable')).toBeTruthy();
    // 死んでいる間の didOpen (クライアントは reset を受けて開き直す) は LS に届かない
    ws.push({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'typescript', version: 2, text: 'x' } } });
    const resetsBefore = ws.sent.filter((m) => m.method === '$/prontella/reset').length;
    ws.push({ method: '$/prontella/restart' });
    await settle();
    // 再起動で reset が告げられ、クライアントの開き直しが新プロセスに届く
    expect(ws.sent.filter((m) => m.method === '$/prontella/reset').length).toBe(resetsBefore + 1);
    ws.push({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'typescript', version: 3, text: 'y' } } });
    await settle();
    expect(children).toHaveLength(4);
    expect(child().received.filter((m) => m.method === 'textDocument/didOpen')).toHaveLength(1);
    ws.push({ id: 9, method: 'textDocument/hover', params: { textDocument: { uri }, position: { line: 0, character: 0 } } });
    await settle();
    expect(ws.find((m) => m.id === 9)).toMatchObject({ result: { echo: 'textDocument/hover' } });
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

describe('workspace/didChangeWatchedFiles', () => {
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  it('LS が登録した glob に合うファイルの生成/変更/削除を、デバウンスして 1 通知にまとめて流す。.git と glob 外は捨てる', async () => {
    const { connect, child, watchers } = setup();
    const ws = connect();
    sockets.push(ws);
    await settle();
    expect(watchers).toHaveLength(0); // 登録が来るまで監視しない
    // tsgo と同じ形: 絶対パスの glob (小文字ドライブ) と Roslyn と同じ形: {baseUri, pattern}
    child().reply({ id: 'ts1', method: 'client/registerCapability', params: { registrations: [
      { id: 'w1', method: 'workspace/didChangeWatchedFiles', registerOptions: { watchers: [{ globPattern: path.join(root, 'vt', '**', '*').split(path.sep).join('/').toLowerCase(), kind: 7 }] } },
      { id: 'w2', method: 'workspace/didChangeWatchedFiles', registerOptions: { watchers: [{ globPattern: { baseUri: pathToFileURL(path.join(root, 'server')).href, pattern: '**/*.cs' } }] } },
    ] } });
    await settle();
    expect(child().received.find((m) => m.id === 'ts1')).toMatchObject({ result: null }); // 応答は従来どおり
    expect(watchers).toHaveLength(1);
    const dir = fs.mkdtempSync(path.join(root, 'vt', 'lsp-watch-'));
    const rel = path.relative(root, dir);
    try {
      fs.writeFileSync(path.join(dir, 'new.ts'), 'export {}');
      const w = watchers[0]!;
      w.onEvent('rename', path.join(rel, 'new.ts'));
      w.onEvent('change', path.join(rel, 'new.ts')); // rename の後の change は rename が勝つ
      w.onEvent('rename', path.join(rel, 'gone.ts')); // 存在しない → Deleted
      w.onEvent('change', path.join('.git', 'index')); // 捨てる
      w.onEvent('change', path.join('server', 'lsp', 'host.ts')); // w2 は .cs だけ → 捨てる
      w.onEvent('rename', rel); // ディレクトリー → 捨てる
      expect(child().received.some((m) => m.method === 'workspace/didChangeWatchedFiles')).toBe(false); // デバウンス中
      await wait(400);
      const notes = child().received.filter((m) => m.method === 'workspace/didChangeWatchedFiles');
      expect(notes).toHaveLength(1);
      expect(notes[0]!.params).toEqual({
        changes: [
          { uri: pathToFileURL(path.join(dir, 'new.ts')).href, type: 1 },
          { uri: pathToFileURL(path.join(dir, 'gone.ts')).href, type: 3 },
        ],
      });
      // 変更は Changed、登録解除で監視が止まる
      w.onEvent('change', path.join(rel, 'new.ts'));
      await wait(400);
      expect(child().received.filter((m) => m.method === 'workspace/didChangeWatchedFiles')[1]!.params).toEqual({ changes: [{ uri: pathToFileURL(path.join(dir, 'new.ts')).href, type: 2 }] });
      child().reply({ id: 'ts2', method: 'client/unregisterCapability', params: { unregisterations: [{ id: 'w1' }, { id: 'w2' }] } });
      await settle();
      expect(w.closed).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('プロセスが終わると監視も終わる', async () => {
    const { connect, child, watchers } = setup();
    const ws = connect();
    sockets.push(ws);
    await settle();
    child().reply({ id: 'ts1', method: 'client/registerCapability', params: { registrations: [{ id: 'w', method: 'workspace/didChangeWatchedFiles', registerOptions: { watchers: [{ globPattern: path.join(root, '**', '*') }] } }] } });
    await settle();
    expect(watchers).toHaveLength(1);
    child().crash();
    expect(watchers[0]!.closed).toBe(true);
  });

  it('globToAbsolute / matchesGlobs: 文字列・RelativePattern・大文字小文字 (win32)', () => {
    expect(globToAbsolute('C:/r/**/*')).toBe('C:/r/**/*');
    expect(globToAbsolute('**/*.cs')).toBeNull();
    expect(globToAbsolute({ baseUri: pathToFileURL(path.join(root, 'a')).href, pattern: '**/*{.cs,.razor}' })).toBe(path.join(root, 'a', '**/*{.cs,.razor}'));
    expect(globToAbsolute({ baseUri: { uri: pathToFileURL(path.join(root, 'a')).href }, pattern: 'X.csproj' })).toBe(path.join(root, 'a', 'X.csproj'));
    expect(globToAbsolute(7)).toBeNull();
    const g = path.join(root, 'a', '**/*{.cs,.razor}');
    expect(matchesGlobs([g], path.join(root, 'a', 'b', 'C.cs'))).toBe(true);
    expect(matchesGlobs([g], path.join(root, 'a', 'b', 'C.razor'))).toBe(true);
    expect(matchesGlobs([g], path.join(root, 'a', 'b', 'C.ts'))).toBe(false);
    expect(matchesGlobs([g], path.join(root, 'z', 'C.cs'))).toBe(false);
    if (process.platform === 'win32') expect(matchesGlobs([g.toLowerCase()], path.join(root, 'A', 'C.CS'))).toBe(true);
  });
});

describe('workspace/symbol', () => {
  it('doc を持たない要求は全プロセスへ流し、配列を連結して 1 応答にする (URI はワイヤー形式)', async () => {
    const dirs: Record<string, string[]> = { [path.join(root, 'a')]: ['A.sln'], [path.join(root, 'b')]: ['B.sln'] };
    const { connect, children } = setup();
    const ws = connect('csharp', (p) => dirs[path.resolve(p)] ?? []);
    sockets.push(ws);
    const token = (ws.sent[0]!.params as { rootToken: string }).rootToken;
    for (const n of ['a', 'b']) ws.push({ method: 'textDocument/didOpen', params: { textDocument: { uri: `file:///${token}/${n}/X.cs`, languageId: 'csharp', version: 1, text: '' } } });
    await settle();
    for (const [i, c] of children.entries()) {
      const orig = c.reply.bind(c);
      c.reply = (m) => orig(m.id !== undefined && (m.result as { echo?: string } | undefined)?.echo === 'workspace/symbol' ? { id: m.id, result: [{ name: `Sym${i}`, kind: 5, location: { uri: diskUri(`${'ab'[i]}/X.cs`), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } } }] } : m);
    }
    ws.push({ id: 9, method: 'workspace/symbol', params: { query: 'Sym' } });
    await settle();
    const res = ws.find((m) => m.id === 9)!;
    expect((res.result as { name: string; location: { uri: string } }[]).map((s) => [s.name, s.location.uri])).toEqual([
      ['Sym0', `file:///${token}/a/X.cs`],
      ['Sym1', `file:///${token}/b/X.cs`],
    ]);
    expect(ws.sent.filter((m) => m.id === 9)).toHaveLength(1);
  });

  it('プロセスが 1 つも無ければ空配列', async () => {
    const { connect } = setup();
    const ws = connect('csharp', () => []);
    sockets.push(ws);
    ws.push({ id: 1, method: 'workspace/symbol', params: { query: 'x' } });
    expect(ws.last()).toMatchObject({ id: 1, result: [] });
  });
});

describe('csharp: ソリューションごとのプロセス', () => {
  const dirs: Record<string, string[]> = {
    [path.join(root, 'a')]: ['A.sln'],
    [path.join(root, 'b')]: ['B.sln'],
  };
  const listDir = (p: string) => dirs[path.resolve(p)] ?? [];

  it('最寄りの .sln ごとに spawn し solution/open を送り、要求は doc の .sln のプロセスへ届く', async () => {
    const { connect, children } = setup();
    const ws = connect('csharp', listDir);
    sockets.push(ws);
    expect(children).toHaveLength(0); // 接続だけでは起動しない (doc が来てから)
    const token = (ws.sent[0]!.params as { rootToken: string }).rootToken;
    const ua = `file:///${token}/a/src/A.cs`;
    const ub = `file:///${token}/b/src/B.cs`;
    ws.push({ method: 'textDocument/didOpen', params: { textDocument: { uri: ua, languageId: 'csharp', version: 1, text: 'a' } } });
    await settle();
    expect(children).toHaveLength(1);
    const openA = children[0]!.received.find((m) => m.method === 'solution/open')!;
    expect((openA.params as { solution: string }).solution).toBe(pathToFileURL(path.join(root, 'a', 'A.sln')).href);
    expect(ws.find((m) => (m.params as { state?: string; solution?: string } | undefined)?.state === 'ready')).toMatchObject({ params: { solution: 'A.sln' } });

    ws.push({ method: 'textDocument/didOpen', params: { textDocument: { uri: ub, languageId: 'csharp', version: 1, text: 'b' } } });
    await settle();
    expect(children).toHaveLength(2);
    for (const c of children) c.answerDiagnostics();
    await settle();
    ws.push({ id: 1, method: 'textDocument/hover', params: { textDocument: { uri: ub }, position: { line: 0, character: 0 } } });
    ws.push({ id: 2, method: 'textDocument/completion', params: { textDocument: { uri: ua }, position: { line: 0, character: 0 } } });
    await settle();
    expect(children[1]!.received.some((m) => m.method === 'textDocument/hover')).toBe(true);
    expect(children[0]!.received.some((m) => m.method === 'textDocument/hover')).toBe(false);
    // resolve は直前に completion を返したプロセス (A) へ
    ws.push({ id: 3, method: 'completionItem/resolve', params: { label: 'x' } });
    await settle();
    expect(children[0]!.received.some((m) => m.method === 'completionItem/resolve')).toBe(true);
    expect(children[1]!.received.some((m) => m.method === 'completionItem/resolve')).toBe(false);
    // 同じ root の TS セッションは別プロセスで、rootToken は共有
    const ts = connect('typescript');
    sockets.push(ts);
    await settle();
    expect(children).toHaveLength(3);
    expect((ts.sent[0]!.params as { rootToken: string }).rootToken).toBe(token);
  });

  it('lsp.csharp.solution があれば .sln を探さず全 doc をそのプロセスへ', async () => {
    const { connect, children } = setup({ mode: 'lsp', solution: 'b/B.sln' });
    const ws = connect('csharp', listDir);
    sockets.push(ws);
    const token = (ws.sent[0]!.params as { rootToken: string }).rootToken;
    ws.push({ method: 'textDocument/didOpen', params: { textDocument: { uri: `file:///${token}/a/src/A.cs`, languageId: 'csharp', version: 1, text: 'a' } } });
    ws.push({ method: 'textDocument/didOpen', params: { textDocument: { uri: `file:///${token}/x/Loose.cs`, languageId: 'csharp', version: 1, text: 'x' } } });
    await settle();
    expect(children).toHaveLength(1);
    const open = children[0]!.received.find((m) => m.method === 'solution/open')!;
    expect((open.params as { solution: string }).solution).toBe(pathToFileURL(path.join(root, 'b', 'B.sln')).href);
    expect(children[0]!.received.filter((m) => m.method === 'textDocument/didOpen')).toHaveLength(2);
  });

  it('開き直し (所有権移譲) でも温め直し、status に warming 数が載る', async () => {
    const { connect, children } = setup();
    const a = connect('csharp', () => []);
    const b = connect('csharp', () => []);
    sockets.push(a, b);
    const token = (a.sent[0]!.params as { rootToken: string }).rootToken;
    const uri = `file:///${token}/x/Loose.cs`;
    a.push({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'csharp', version: 1, text: 'A' } } });
    await settle();
    expect(a.find((m) => (m.params as { warming?: number } | undefined)?.warming === 1)).toBeTruthy();
    children[0]!.answerDiagnostics();
    await settle();
    expect(a.last()).toMatchObject({ method: '$/prontella/status', params: { state: 'ready' } });
    expect((a.last().params as { warming?: number }).warming).toBeUndefined();
    b.push({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'csharp', version: 2, text: 'B' } } });
    b.push({ id: 1, method: 'textDocument/completion', params: { textDocument: { uri }, position: { line: 0, character: 0 } } });
    await settle();
    expect(children[0]!.received.filter((m) => m.method === 'textDocument/diagnostic')).toHaveLength(2);
    expect(children[0]!.received.some((m) => m.method === 'textDocument/completion')).toBe(false); // 温め中は保留
    children[0]!.answerDiagnostics();
    await settle();
    expect(b.find((m) => m.id === 1)).toMatchObject({ result: { echo: 'textDocument/completion' } });
  });

  it('上限 (4) に当たったら doc を全部閉じたプロセスを LRU で落として空け、空かなければ開いているソリューション名入りで unavailable', async () => {
    const dirs5: Record<string, string[]> = {};
    for (const n of ['a', 'b', 'c', 'd', 'e']) dirs5[path.join(root, n)] = [`${n.toUpperCase()}.sln`];
    const { connect, children } = setup();
    const ws = connect('csharp', (p) => dirs5[path.resolve(p)] ?? []);
    sockets.push(ws);
    const token = (ws.sent[0]!.params as { rootToken: string }).rootToken;
    const uriOf = (n: string) => `file:///${token}/${n}/X.cs`;
    for (const n of ['a', 'b', 'c', 'd']) {
      ws.push({ method: 'textDocument/didOpen', params: { textDocument: { uri: uriOf(n), languageId: 'csharp', version: 1, text: '' } } });
      await settle();
    }
    expect(children).toHaveLength(4);
    ws.push({ method: 'textDocument/didOpen', params: { textDocument: { uri: uriOf('e'), languageId: 'csharp', version: 1, text: '' } } });
    await settle();
    expect(children).toHaveLength(4);
    const limit = ws.find((m) => (m.params as { state?: string } | undefined)?.state === 'unavailable')!;
    expect((limit.params as { error: string }).error).toContain('A.sln, B.sln, C.sln, D.sln');
    // a のファイルを閉じる → a のプロセスは doc 無し → 次の起動で落とされ、e が立つ
    ws.push({ method: 'textDocument/didClose', params: { textDocument: { uri: uriOf('a') } } });
    ws.push({ method: '$/prontella/restart' });
    await settle();
    expect(children[0]!.received.some((m) => m.method === 'shutdown')).toBe(true);
    expect(children.length).toBeGreaterThanOrEqual(5);
    expect(ws.find((m) => (m.params as { state?: string; solution?: string } | undefined)?.state === 'ready' && (m.params as { solution?: string }).solution === 'E.sln')).toBeTruthy();
  });

  it('.sln が無いファイルは solution/open 無しのプロセスで即 ready', async () => {
    const { connect, children } = setup();
    const ws = connect('csharp', () => []);
    sockets.push(ws);
    const token = (ws.sent[0]!.params as { rootToken: string }).rootToken;
    ws.push({ method: 'textDocument/didOpen', params: { textDocument: { uri: `file:///${token}/x/Loose.cs`, languageId: 'csharp', version: 1, text: '' } } });
    await settle();
    expect(children).toHaveLength(1);
    // Roslyn は意味解析が済む前の補完に null を返すので、didOpen の直後にホストが diagnostic で温める
    expect(children[0]!.received.map((m) => m.method)).toEqual(['initialize', 'initialized', 'textDocument/didOpen', 'textDocument/diagnostic']);
    expect(ws.find((m) => (m.params as { state?: string } | undefined)?.state === 'ready')).toBeTruthy();
  });

  it('温めの応答が返るまでその doc への要求を保留し、返ったら順に流す。応答はクライアントへ出さない', async () => {
    const { connect, children } = setup();
    const ws = connect('csharp', () => []);
    sockets.push(ws);
    const token = (ws.sent[0]!.params as { rootToken: string }).rootToken;
    const uri = `file:///${token}/x/Loose.cs`;
    ws.push({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'csharp', version: 1, text: '' } } });
    await settle();
    ws.push({ id: 1, method: 'textDocument/completion', params: { textDocument: { uri }, position: { line: 0, character: 0 } } });
    await settle();
    expect(children[0]!.received.some((m) => m.method === 'textDocument/completion')).toBe(false);
    children[0]!.answerDiagnostics();
    await settle();
    expect(children[0]!.received.some((m) => m.method === 'textDocument/completion')).toBe(true);
    expect(ws.find((m) => m.id === 1)).toMatchObject({ result: { echo: 'textDocument/completion' } });
    expect(ws.sent.some((m) => m.method === undefined && Array.isArray((m.result as { items?: unknown[] } | null)?.items))).toBe(false);
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
