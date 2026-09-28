import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JS_DEBUG_VERSION, checkDebugConfig, downloadJsDebug, resolveAdapter, toolsEntry } from './registry.js';

describe('checkDebugConfig', () => {
  it('未設定は既定、文字列の検証', () => {
    expect(checkDebugConfig(undefined)).toEqual({ ok: true, config: { node: {} } });
    expect(checkDebugConfig({ node: { dapDebugServer: '/x/dapDebugServer.js' } })).toEqual({ ok: true, config: { node: { dapDebugServer: '/x/dapDebugServer.js' } } });
    expect(checkDebugConfig([])).toMatchObject({ ok: false });
    expect(checkDebugConfig({ node: 'x' })).toMatchObject({ ok: false });
    expect(checkDebugConfig({ node: { dapDebugServer: '' } })).toMatchObject({ ok: false });
    expect(checkDebugConfig({ node: { dapDebugServer: 'a\nb' } })).toMatchObject({ ok: false });
  });
});

describe('resolveAdapter', () => {
  const home = path.resolve('/home/u');
  const toolsDir = path.join(home, '.prontella', 'tools');
  const ext = path.join(home, '.vscode', 'extensions');
  const base = { execPath: 'node', home, toolsDir, listDir: () => [] as string[] };
  it('config > tools > VS Code 拡張 (新しい版) > null', () => {
    const extNew = path.join(ext, 'ms-vscode.js-debug-1.99.0', 'src', 'dapDebugServer.js');
    const extOld = path.join(ext, 'ms-vscode.js-debug-1.98.0', 'src', 'dapDebugServer.js');
    const all = new Set([toolsEntry(toolsDir), extNew, extOld]);
    const listDir = (d: string) => (d === ext ? ['ms-vscode.js-debug-1.98.0', 'ms-vscode.js-debug-1.99.0', 'other'] : []);
    expect(resolveAdapter({ ...base, config: { dapDebugServer: '/c.js' }, exists: (p) => all.has(p), listDir })).toMatchObject({ args: ['/c.js'], source: 'config' });
    expect(resolveAdapter({ ...base, config: {}, exists: (p) => all.has(p), listDir })).toMatchObject({ args: [toolsEntry(toolsDir)], source: 'tools' });
    expect(resolveAdapter({ ...base, config: {}, exists: (p) => p !== toolsEntry(toolsDir) && all.has(p), listDir })).toMatchObject({ args: [extNew], source: 'vscode-ext' });
    expect(resolveAdapter({ ...base, config: {}, exists: () => false, listDir })).toBeNull();
  });
});

describe('downloadJsDebug', () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fakeFetch = (status = 200) => (async () => new Response(new Uint8Array([1, 2, 3]), { status })) as unknown as typeof fetch;
  const fakeExtract = async (_archive: string, out: string) => {
    fs.mkdirSync(path.join(out, 'js-debug', 'src'), { recursive: true });
    fs.writeFileSync(path.join(out, 'js-debug', 'src', 'dapDebugServer.js'), '// fake');
  };
  it('完成形は rename でだけ現れ、package.json を書き、残骸を消す。2 回目は落とさない', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dap-reg-'));
    let fetched = 0;
    const f = (async (...a: Parameters<typeof fetch>) => (fetched++, fakeFetch()(...a))) as typeof fetch;
    const [a, b] = await Promise.all([downloadJsDebug({ toolsDir: dir, fetch: f, extract: fakeExtract }), downloadJsDebug({ toolsDir: dir, fetch: f, extract: fakeExtract })]);
    expect(a).toBe(toolsEntry(dir));
    expect(b).toBe(a);
    expect(fetched).toBe(1);
    expect(fs.existsSync(a)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'js-debug', JS_DEBUG_VERSION, 'js-debug', 'package.json'), 'utf8'))).toEqual({ type: 'commonjs' });
    expect(fs.readdirSync(path.join(dir, 'js-debug'))).toEqual([JS_DEBUG_VERSION]);
    await downloadJsDebug({ toolsDir: dir, fetch: f, extract: fakeExtract });
    expect(fetched).toBe(1);
  });
  it('HTTP 失敗・展開失敗は例外で、完成形もゴミも残らない', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dap-reg-'));
    await expect(downloadJsDebug({ toolsDir: dir, fetch: fakeFetch(404), extract: fakeExtract })).rejects.toThrow(/404/);
    await expect(downloadJsDebug({ toolsDir: dir, fetch: fakeFetch(), extract: async () => {} })).rejects.toThrow(/dapDebugServer/);
    expect(fs.readdirSync(path.join(dir, 'js-debug'))).toEqual([]);
  });
});
