import { EventEmitter } from 'node:events';
import path from 'node:path';
import type { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import type { Adapter, AdapterConn, DapMessage } from './host.js';
import { attachDebug, rewriteSources } from './session.js';

type Wire = DapMessage & { sessionId?: string };

class FakeWs extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  sent: Wire[] = [];
  closedWith: number | null = null;
  send(s: string): void {
    this.sent.push(JSON.parse(s));
  }
  close(code?: number): void {
    this.readyState = 3;
    this.closedWith = code ?? 1000;
    this.emit('close');
  }
  push(msg: Wire): void {
    this.emit('message', Buffer.from(JSON.stringify(msg)));
  }
  responses(): Wire[] {
    return this.sent.filter((m) => m.type === 'response');
  }
  events(name: string): Wire[] {
    return this.sent.filter((m) => m.type === 'event' && m.event === name);
  }
}

/** 偽アダプター: 接続ごとに受信を記録し、テストから応答/イベント/逆要求を注入する */
class FakeAdapter implements Adapter {
  port = 1;
  pid = 4242;
  killed = false;
  conns: Array<{ received: DapMessage[]; emit: (m: DapMessage) => void; closed: boolean }> = [];
  stderrTail(): string {
    return '';
  }
  connect(onMessage: (msg: DapMessage) => void, onClose: () => void): AdapterConn {
    const c = { received: [] as DapMessage[], emit: onMessage, closed: false };
    this.conns.push(c);
    return {
      send: (m) => c.received.push(m),
      close: () => {
        c.closed = true;
        onClose();
      },
    };
  }
  kill(): void {
    this.killed = true;
  }
}

const tick = () => new Promise<void>((r) => setImmediate(r));
async function settle() {
  for (let i = 0; i < 5; i++) await tick();
}

const root = path.resolve('/work/app');
const launchJson = JSON.stringify({ configurations: [{ type: 'node', request: 'launch', name: 'A', program: '${workspaceFolder}/a.js' }] });

async function setup(opts: { launchJson?: string | null; failStart?: string; resolveNull?: boolean } = {}) {
  const ws = new FakeWs();
  const adapter = new FakeAdapter();
  let downloads = 0;
  attachDebug(ws as unknown as WebSocket, root, {
    adapter: 'node',
    config: {},
    toolsDir: '/tools',
    env: () => ({}),
    resolve: () => (opts.resolveNull && downloads === 0 ? null : { command: 'node', args: ['dap.js'], source: 'tools', transport: 'tcp' }),
    download: async () => {
      downloads++;
      return '/tools/x';
    },
    start: async () => {
      if (opts.failStart) throw new Error(opts.failStart);
      return adapter;
    },
    readLaunchJson: () => (opts.launchJson === undefined ? launchJson : opts.launchJson),
    exists: () => true,
    listDir: () => [],
  });
  await settle();
  return { ws, adapter, downloads: () => downloads };
}

describe('attachDebug: 起動と状態', () => {
  it('resolving → starting → ready、root セッションを告げる', async () => {
    const { ws, adapter } = await setup();
    expect(ws.events('prontella/status').map((e) => (e.body as { state: string }).state)).toEqual(['resolving', 'starting', 'ready']);
    expect(ws.events('prontella/session')[0]!.body).toEqual({ sessionId: 's1', parentSessionId: null, request: null });
    expect(adapter.conns).toHaveLength(1);
  });
  it('未検出ならダウンロードしてから起動する', async () => {
    const { ws, downloads } = await setup({ resolveNull: true });
    expect(downloads()).toBe(1);
    expect(ws.events('prontella/status').map((e) => (e.body as { state: string }).state)).toEqual(['resolving', 'downloading', 'starting', 'ready']);
  });
  it('起動失敗は failed + close(4004)', async () => {
    const { ws } = await setup({ failStart: 'boom' });
    expect(ws.events('prontella/status').at(-1)!.body).toMatchObject({ state: 'failed', error: 'boom' });
    expect(ws.closedWith).toBe(4004);
  });
});

describe('attachDebug: クライアント → アダプター', () => {
  it('launch は {name} を launch.json の本体に差し替え、console を上書きする', async () => {
    const { ws, adapter } = await setup();
    ws.push({ seq: 7, type: 'request', command: 'launch', arguments: { name: 'A', program: 'C:\\evil.js' }, sessionId: 's1' });
    const sent = adapter.conns[0]!.received[0]!;
    expect(sent).toEqual({ seq: 7, type: 'request', command: 'launch', arguments: { cwd: root, type: 'pwa-node', request: 'launch', name: 'A', program: `${root}/a.js`, console: 'internalConsole' } });
  });
  it('未知の name / root 外 file / request の不一致は error 応答で未転送', async () => {
    const { ws, adapter } = await setup();
    ws.push({ seq: 1, type: 'request', command: 'launch', arguments: { name: 'nope' }, sessionId: 's1' });
    ws.push({ seq: 2, type: 'request', command: 'launch', arguments: { file: '../x.js' }, sessionId: 's1' });
    ws.push({ seq: 3, type: 'request', command: 'attach', arguments: { name: 'A' }, sessionId: 's1' });
    expect(adapter.conns[0]!.received).toEqual([]);
    expect(ws.responses().map((r) => [r.request_seq, r.success])).toEqual([[1, false], [2, false], [3, false]]);
  });
  it('setBreakpoints の path を絶対化し、root 外は拒否', async () => {
    const { ws, adapter } = await setup();
    ws.push({ seq: 1, type: 'request', command: 'setBreakpoints', arguments: { source: { path: 'src/a.js' }, breakpoints: [{ line: 3 }] }, sessionId: 's1' });
    ws.push({ seq: 2, type: 'request', command: 'setBreakpoints', arguments: { source: { path: '../../x.js' }, breakpoints: [] }, sessionId: 's1' });
    expect(adapter.conns[0]!.received).toEqual([{ seq: 1, type: 'request', command: 'setBreakpoints', arguments: { source: { path: path.join(root, 'src', 'a.js') }, breakpoints: [{ line: 3 }] } }]);
    expect(ws.responses()).toMatchObject([{ request_seq: 2, success: false, sessionId: 's1' }]);
  });
  it('未知のセッション・未知のコマンド・ping・非オブジェクトは転送しない', async () => {
    const { ws, adapter } = await setup();
    ws.push({ seq: 1, type: 'request', command: 'threads', sessionId: 'zzz' });
    ws.push({ seq: 2, type: 'request', command: 'runInTerminal', sessionId: 's1' });
    ws.push({ type: 'ping' } as Wire);
    ws.emit('message', Buffer.from('"str"'));
    ws.emit('message', Buffer.from('{'));
    expect(adapter.conns[0]!.received).toEqual([]);
    expect(ws.responses().map((r) => [r.request_seq, r.success])).toEqual([[1, false], [2, false]]);
  });
});

describe('attachDebug: アダプター → クライアント', () => {
  it('source.path を root 相対にし、root 外は path を消す。loadedSource と telemetry は捨てる', async () => {
    const { ws, adapter } = await setup();
    const c = adapter.conns[0]!;
    c.emit({ seq: 1, type: 'event', event: 'loadedSource', body: {} });
    c.emit({ seq: 2, type: 'event', event: 'output', body: { category: 'telemetry', output: 'x' } });
    c.emit({
      seq: 3, type: 'response', request_seq: 9, command: 'stackTrace', success: true,
      body: { stackFrames: [
        { id: 1, source: { name: path.join(root, 'src', 'a.js'), path: path.join(root, 'src', 'a.js'), sourceReference: 0 }, line: 3 },
        { id: 2, source: { name: '<node_internals>/fs', path: '<node_internals>/fs', sourceReference: 77 }, line: 1 },
        { id: 3, source: { name: 'z.js', path: path.resolve('/elsewhere/z.js'), sourceReference: 0 }, line: 1 },
      ] },
    });
    c.emit({ seq: 4, type: 'event', event: 'output', body: { category: 'console', output: `${process.execPath} ./x.js\n` } });
    expect((ws.events('output')[0]!.body as { output: string }).output.startsWith(require('node:os').homedir())).toBe(false);
    expect(ws.sent.filter((m) => m.type === 'response')).toEqual([{
      seq: 3, type: 'response', request_seq: 9, command: 'stackTrace', success: true, sessionId: 's1',
      body: { stackFrames: [
        { id: 1, source: { name: 'a.js', path: 'src/a.js', sourceReference: 0 }, line: 3 },
        { id: 2, source: { name: '<node_internals>/fs', sourceReference: 77 }, line: 1 },
        { id: 3, source: { name: 'z.js', sourceReference: 0 }, line: 1 },
      ] },
    }]);
  });
  it.runIf(process.platform === 'win32')('win32: 小文字ドライブ (js-debug の応答形) も root 内と判定し、相対部分の大小文字は保つ', async () => {
    const { ws, adapter } = await setup();
    const lower = root.toLowerCase();
    adapter.conns[0]!.emit({ seq: 1, type: 'event', event: 'breakpoint', body: { breakpoint: { id: 1, verified: true, source: { path: path.join(lower, 'Src', 'Program.cs') } } } });
    expect(ws.events('breakpoint')[0]!.body).toEqual({ breakpoint: { id: 1, verified: true, source: { path: 'Src/Program.cs' } } });
  });
  it('startDebugging → 2 本目の接続 + prontella/session、子の launch には configuration を注入', async () => {
    const { ws, adapter } = await setup();
    adapter.conns[0]!.emit({ seq: 5, type: 'request', command: 'startDebugging', arguments: { request: 'launch', configuration: { type: 'pwa-node', __pendingTargetId: 'p1' } } });
    expect(adapter.conns).toHaveLength(2);
    expect(adapter.conns[0]!.received).toEqual([{ seq: 1_000_000, type: 'response', request_seq: 5, command: 'startDebugging', success: true }]);
    expect(ws.events('prontella/session').at(-1)!.body).toEqual({ sessionId: 's2', parentSessionId: 's1', request: 'launch' });
    ws.push({ seq: 3, type: 'request', command: 'launch', arguments: { program: 'C:\\evil.js' }, sessionId: 's2' });
    expect(adapter.conns[1]!.received).toEqual([{ seq: 3, type: 'request', command: 'launch', arguments: { type: 'pwa-node', __pendingTargetId: 'p1' } }]);
    adapter.conns[1]!.emit({ seq: 1, type: 'event', event: 'stopped', body: { threadId: 0 } });
    expect(ws.events('stopped')[0]).toMatchObject({ sessionId: 's2' });
  });
  it('runInTerminal は error 応答', async () => {
    const { adapter } = await setup();
    adapter.conns[0]!.emit({ seq: 5, type: 'request', command: 'runInTerminal', arguments: {} });
    expect(adapter.conns[0]!.received[0]).toMatchObject({ type: 'response', request_seq: 5, success: false });
  });
});

describe('attachDebug: 後始末', () => {
  it('ws close → root に disconnect → 猶予後に kill', async () => {
    const { ws, adapter } = await setup();
    ws.close();
    expect(adapter.conns[0]!.received.at(-1)).toMatchObject({ command: 'disconnect', arguments: { terminateDebuggee: true } });
    expect(adapter.killed).toBe(false);
    await new Promise((r) => setTimeout(r, 1_100));
    expect(adapter.killed).toBe(true);
  });
});

describe('rewriteSources', () => {
  it('ネストした source だけを書き換える', () => {
    const out = rewriteSources({ a: [{ source: { path: 'x', name: 'n' } }], source: { name: 'no-path' }, b: { source: { path: 'y' } } }, (s) => ({ ...s, path: 'R' }));
    expect(out).toEqual({ a: [{ source: { path: 'R', name: 'n' } }], source: { name: 'no-path' }, b: { source: { path: 'R' } } });
  });
});
