import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JS_DEBUG_VERSION, NETCOREDBG_VERSION, checkDebugConfig, downloadAdapter, resolveAdapter, toolsEntry } from './registry.js';

describe('checkDebugConfig', () => {
  it('未設定は既定、文字列の検証', () => {
    expect(checkDebugConfig(undefined)).toEqual({ ok: true, config: { node: {}, csharp: {} } });
    expect(checkDebugConfig({ node: { dapDebugServer: '/x/dapDebugServer.js' }, csharp: { netcoredbg: '/y/netcoredbg' } })).toEqual({
      ok: true,
      config: { node: { dapDebugServer: '/x/dapDebugServer.js' }, csharp: { netcoredbg: '/y/netcoredbg' } },
    });
    expect(checkDebugConfig([])).toMatchObject({ ok: false });
    expect(checkDebugConfig({ node: 'x' })).toMatchObject({ ok: false });
    expect(checkDebugConfig({ node: { dapDebugServer: '' } })).toMatchObject({ ok: false });
    expect(checkDebugConfig({ csharp: { netcoredbg: 'a\nb' } })).toMatchObject({ ok: false, error: expect.stringContaining('debug.csharp.netcoredbg') });
  });
});

describe('resolveAdapter', () => {
  const home = path.resolve('/home/u');
  const toolsDir = path.join(home, '.prontella', 'tools');
  const ext = path.join(home, '.vscode', 'extensions');
  const base = { execPath: 'node', home, toolsDir, listDir: () => [] as string[] };
  it('node: config > tools > VS Code 拡張 (新しい版) > null', () => {
    const extNew = path.join(ext, 'ms-vscode.js-debug-1.99.0', 'src', 'dapDebugServer.js');
    const extOld = path.join(ext, 'ms-vscode.js-debug-1.98.0', 'src', 'dapDebugServer.js');
    const all = new Set([toolsEntry(toolsDir, 'node'), extNew, extOld]);
    const listDir = (d: string) => (d === ext ? ['ms-vscode.js-debug-1.98.0', 'ms-vscode.js-debug-1.99.0', 'other'] : []);
    expect(resolveAdapter({ ...base, config: { dapDebugServer: '/c.js' }, exists: (p) => all.has(p), listDir }, 'node')).toMatchObject({ args: ['/c.js'], source: 'config', transport: 'tcp' });
    expect(resolveAdapter({ ...base, config: {}, exists: (p) => all.has(p), listDir }, 'node')).toMatchObject({ args: [toolsEntry(toolsDir, 'node')], source: 'tools' });
    expect(resolveAdapter({ ...base, config: {}, exists: (p) => p !== toolsEntry(toolsDir, 'node') && all.has(p), listDir }, 'node')).toMatchObject({ args: [extNew], source: 'vscode-ext' });
    expect(resolveAdapter({ ...base, config: {}, exists: () => false, listDir }, 'node')).toBeNull();
  });
  it('csharp: config > tools > PATH > null、stdio', () => {
    const exe = process.platform === 'win32' ? '.exe' : '';
    const onPath = path.join(path.resolve('/opt/dbg'), 'netcoredbg' + exe);
    const all = new Set([toolsEntry(toolsDir, 'csharp'), onPath]);
    const envPath = [path.resolve('/nope'), path.resolve('/opt/dbg')].join(process.platform === 'win32' ? ';' : ':');
    expect(resolveAdapter({ ...base, config: { netcoredbg: '/c/netcoredbg' }, exists: (p) => all.has(p), envPath }, 'csharp')).toEqual({ command: '/c/netcoredbg', args: ['--interpreter=vscode'], source: 'config', transport: 'stdio' });
    expect(resolveAdapter({ ...base, config: {}, exists: (p) => all.has(p), envPath }, 'csharp')).toMatchObject({ command: toolsEntry(toolsDir, 'csharp'), source: 'tools' });
    expect(resolveAdapter({ ...base, config: {}, exists: (p) => p === onPath, envPath }, 'csharp')).toMatchObject({ command: onPath, source: 'path' });
    expect(resolveAdapter({ ...base, config: {}, exists: () => false, envPath }, 'csharp')).toBeNull();
  });
});

describe('downloadAdapter', () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fakeFetch = (status = 200) => (async () => new Response(new Uint8Array([1, 2, 3]), { status })) as unknown as typeof fetch;
  const fakeExtract = (rel: string) => async (_archive: string, out: string) => {
    fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true });
    fs.writeFileSync(path.join(out, rel), '// fake');
  };
  const jsEntry = path.join('js-debug', 'src', 'dapDebugServer.js');
  it('完成形は rename でだけ現れ、package.json を書き、残骸を消す。2 回目は落とさない', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dap-reg-'));
    let fetched = 0;
    const f = (async (...a: Parameters<typeof fetch>) => (fetched++, fakeFetch()(...a))) as typeof fetch;
    const deps = { toolsDir: dir, fetch: f, extract: fakeExtract(jsEntry) };
    const [a, b] = await Promise.all([downloadAdapter('node', deps), downloadAdapter('node', deps)]);
    expect(a).toBe(toolsEntry(dir, 'node'));
    expect(b).toBe(a);
    expect(fetched).toBe(1);
    expect(fs.existsSync(a)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'js-debug', JS_DEBUG_VERSION, 'js-debug', 'package.json'), 'utf8'))).toEqual({ type: 'commonjs' });
    expect(fs.readdirSync(path.join(dir, 'js-debug'))).toEqual([JS_DEBUG_VERSION]);
    await downloadAdapter('node', deps);
    expect(fetched).toBe(1);
  });
  it('csharp: platform ごとの資産、対応外は例外', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dap-reg-'));
    const urls: string[] = [];
    const f = (async (u: string | URL | Request) => (urls.push(String(u)), fakeFetch()(u))) as typeof fetch;
    const entry = path.join('netcoredbg', 'netcoredbg' + (process.platform === 'win32' ? '.exe' : ''));
    await downloadAdapter('csharp', { toolsDir: dir, fetch: f, extract: fakeExtract(entry), platform: 'win32', arch: 'x64' });
    expect(urls[0]).toContain(`${NETCOREDBG_VERSION}/netcoredbg-win64.zip`);
    expect(fs.readdirSync(path.join(dir, 'netcoredbg'))).toEqual([NETCOREDBG_VERSION]);
    fs.rmSync(path.join(dir, 'netcoredbg'), { recursive: true });
    await expect(downloadAdapter('csharp', { toolsDir: dir, fetch: f, extract: fakeExtract(entry), platform: 'freebsd', arch: 'x64' })).rejects.toThrow(/配布物がありません/);
  });
  it('HTTP 失敗・展開失敗は例外で、完成形もゴミも残らない', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dap-reg-'));
    await expect(downloadAdapter('node', { toolsDir: dir, fetch: fakeFetch(404), extract: fakeExtract(jsEntry) })).rejects.toThrow(/404/);
    await expect(downloadAdapter('node', { toolsDir: dir, fetch: fakeFetch(), extract: async () => {} })).rejects.toThrow(/dapDebugServer/);
    expect(fs.readdirSync(path.join(dir, 'js-debug'))).toEqual([]);
  });
});
