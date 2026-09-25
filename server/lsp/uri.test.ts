import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createExtTable, docToUri, rewriteUris, uriToWire, wireToUri } from './uri.js';

const win = process.platform === 'win32';
// 空白と日本語を含む root。Windows ではドライブレターの大小も往復で試す。
const root = win ? 'C:\\Users\\me\\My Repo\\プロジェクト' : '/home/me/My Repo/プロジェクト';
const token = 'r1';

describe('docToUri', () => {
  it('root 相対パスを file URI にする (空白・日本語はパーセントエンコード)', () => {
    const uri = docToUri(root, 'src/a b/日本.ts');
    expect(uri).toBe(pathToFileURL(path.join(root, 'src', 'a b', '日本.ts')).href);
    expect(uri).toContain('%20');
    expect(uri).toContain('%E6%97%A5%E6%9C%AC');
  });

  it('`..` で root 外へ出る rel は safeResolve が弾く', () => {
    expect(() => docToUri(root, '../secret.ts')).toThrow();
    expect(() => docToUri(root, 'src/../../secret.ts')).toThrow();
  });
});

describe('uriToWire / wireToUri', () => {
  it('root 配下の URI を <token>/<rel> に往復する', () => {
    const ext = createExtTable();
    const disk = docToUri(root, 'src/a b/日本.ts');
    const wire = uriToWire(root, token, ext, disk);
    expect(wire).toBe('file:///r1/src/a%20b/%E6%97%A5%E6%9C%AC.ts');
    expect(wireToUri(root, token, ext, wire)).toBe(disk);
  });

  it.runIf(win)('小文字ドライブレターと %3A (tsgo の出力形) も root 配下と判定する', () => {
    const ext = createExtTable();
    const lower = 'file:///c%3A/Users/me/My%20Repo/%E3%83%97%E3%83%AD%E3%82%B8%E3%82%A7%E3%82%AF%E3%83%88/src/x.ts';
    expect(uriToWire(root, token, ext, lower)).toBe('file:///r1/src/x.ts');
  });

  it('root 自身は空 rel', () => {
    const ext = createExtTable();
    expect(uriToWire(root, token, ext, pathToFileURL(root).href)).toBe('file:///r1/');
  });

  it('root 外は <token>-ext/<opaque>/<basename> にし、逆変換は表からだけ引く', () => {
    const ext = createExtTable();
    const lib = path.join(os.tmpdir(), 'node_modules', 'typescript', 'lib', 'lib.dom.d.ts');
    const wire = uriToWire(root, token, ext, pathToFileURL(lib).href);
    expect(wire).toBe('file:///r1-ext/e1/lib.dom.d.ts');
    expect(wireToUri(root, token, ext, wire)).toBe(pathToFileURL(lib).href);
    // 同じパスは同じ opaque
    expect(uriToWire(root, token, ext, pathToFileURL(lib).href)).toBe(wire);
    // 表に無い opaque は解釈しない
    expect(wireToUri(root, token, ext, 'file:///r1-ext/e99/x.ts')).toBeNull();
  });

  it('root の接頭辞が一致するだけの兄弟ディレクトリーは root 外', () => {
    const ext = createExtTable();
    const sibling = pathToFileURL(root + '2/x.ts').href;
    expect(uriToWire(root, token, ext, sibling)).toMatch(/^file:\/\/\/r1-ext\//);
  });

  it('ワイヤー側からの脱出 (`..`・空セグメント・別トークン・非 file) は null', () => {
    const ext = createExtTable();
    expect(wireToUri(root, token, ext, 'file:///r1/../x.ts')).toBeNull();
    expect(wireToUri(root, token, ext, 'file:///r1/src/%2E%2E/x.ts')).toBeNull();
    expect(wireToUri(root, token, ext, 'file:///r1//x.ts')).toBeNull();
    expect(wireToUri(root, token, ext, 'file:///r2/x.ts')).toBeNull();
    expect(wireToUri(root, token, ext, 'untitled:x.ts')).toBeNull();
    expect(wireToUri(root, token, ext, 'file:///C:/Users/me/x.ts')).toBeNull();
  });

  it('file 以外のスキームは素通し', () => {
    const ext = createExtTable();
    expect(uriToWire(root, token, ext, 'untitled:Untitled-1')).toBe('untitled:Untitled-1');
  });
});

describe('rewriteUris', () => {
  const fn = (u: string) => (u === 'file:///a' ? 'file:///A' : null);

  it('入れ子・配列・オブジェクトのキーを書き換える', () => {
    const input = {
      uri: 'file:///a',
      list: [{ targetUri: 'file:///a' }, 'file:///a', 'plain'],
      changes: { 'file:///a': [{ newText: 'x' }] },
      n: 1,
      nul: null,
    };
    expect(rewriteUris(input, fn)).toEqual({
      uri: 'file:///A',
      list: [{ targetUri: 'file:///A' }, 'file:///A', 'plain'],
      changes: { 'file:///A': [{ newText: 'x' }] },
      n: 1,
      nul: null,
    });
  });

  it('fn が null を返した値は落とし、キーなら項目ごと落とす', () => {
    expect(rewriteUris({ uri: 'file:///zzz', changes: { 'file:///zzz': [] } }, fn)).toEqual({ uri: undefined, changes: {} });
  });

  it('file: で始まらない文字列は fn を呼ばない', () => {
    let calls = 0;
    rewriteUris({ a: 'http://x', b: ['s'] }, () => (calls++, null));
    expect(calls).toBe(0);
  });
});
