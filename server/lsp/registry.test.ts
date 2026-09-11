import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkLspConfig, languageIdFor, resolveLaunch, serverIdFor, type ResolveEnv } from './registry.js';

describe('languageIdFor', () => {
  it('.tsx は typescriptreact、.jsx は javascriptreact (tsgo は最初の languageId で固定するため)', () => {
    expect(languageIdFor('src/App.tsx')).toBe('typescriptreact');
    expect(languageIdFor('src/App.jsx')).toBe('javascriptreact');
    expect(languageIdFor('src/a.ts')).toBe('typescript');
    expect(languageIdFor('src/a.mts')).toBe('typescript');
    expect(languageIdFor('src/a.cts')).toBe('typescript');
    expect(languageIdFor('src/a.js')).toBe('javascript');
    expect(languageIdFor('src/a.mjs')).toBe('javascript');
    expect(languageIdFor('src/a.cjs')).toBe('javascript');
  });

  it('大文字拡張子・拡張子無し・非対応', () => {
    expect(languageIdFor('A.TSX')).toBe('typescriptreact');
    expect(languageIdFor('Makefile')).toBeNull();
    expect(languageIdFor('a.py')).toBeNull();
    expect(languageIdFor('dir.ts/readme')).toBeNull();
  });

  it('serverIdFor は全部 typescript', () => {
    expect(serverIdFor('javascriptreact')).toBe('typescript');
  });
});

describe('checkLspConfig', () => {
  it('未指定は builtin', () => {
    expect(checkLspConfig(undefined)).toEqual({ ok: true, config: { typescript: { mode: 'builtin' } } });
    expect(checkLspConfig(null)).toEqual({ ok: true, config: { typescript: { mode: 'builtin' } } });
    expect(checkLspConfig({})).toEqual({ ok: true, config: { typescript: { mode: 'builtin' } } });
  });

  it('配列・文字列・数値は弾く (typeof を先に見る)', () => {
    expect(checkLspConfig([]).ok).toBe(false);
    expect(checkLspConfig('lsp').ok).toBe(false);
    expect(checkLspConfig({ typescript: [] }).ok).toBe(false);
    expect(checkLspConfig({ typescript: 'lsp' }).ok).toBe(false);
  });

  it('mode の値域', () => {
    expect(checkLspConfig({ typescript: { mode: 'lsp' } })).toEqual({ ok: true, config: { typescript: { mode: 'lsp' } } });
    expect(checkLspConfig({ typescript: { mode: 'on' } }).ok).toBe(false);
    expect(checkLspConfig({ typescript: { mode: true } }).ok).toBe(false);
  });

  it('command / args は制御文字を拒否', () => {
    expect(checkLspConfig({ typescript: { command: 'C:\\x\\cli.mjs', args: ['--stdio'] } })).toEqual({
      ok: true,
      config: { typescript: { mode: 'builtin', command: 'C:\\x\\cli.mjs', args: ['--stdio'] } },
    });
    expect(checkLspConfig({ typescript: { command: '' } }).ok).toBe(false);
    expect(checkLspConfig({ typescript: { command: 'a\nb' } }).ok).toBe(false);
    expect(checkLspConfig({ typescript: { command: 'a', args: ['x\u0000'] } }).ok).toBe(false);
    expect(checkLspConfig({ typescript: { command: 'a', args: 'x' } }).ok).toBe(false);
  });
});

describe('resolveLaunch', () => {
  const root = path.resolve('/repo');
  const nm = path.join(root, 'node_modules');
  const base = (exists: string[], extra: Partial<ResolveEnv> = {}): ResolveEnv => ({
    root,
    config: { mode: 'lsp' },
    env: { PATH: '' },
    platform: 'win32',
    arch: 'x64',
    execPath: 'NODE',
    exists: (p) => exists.map((e) => path.resolve(e)).includes(path.resolve(p)),
    ...extra,
  });
  const tsgo = path.join(nm, '@typescript', 'typescript-win32-x64', 'lib', 'tsc.exe');
  const getExe = path.join(nm, 'typescript', 'lib', 'getExePath.js');
  const tsserver = path.join(nm, 'typescript', 'lib', 'tsserver.js');
  const cli = path.join(nm, 'typescript-language-server', 'lib', 'cli.mjs');

  it('1. ワークスペースの TS 7 (tsgo) が最優先', () => {
    expect(resolveLaunch(base([getExe, tsgo, cli, tsserver], { config: { mode: 'lsp', command: 'X' } }))).toEqual({
      command: tsgo,
      args: ['--lsp', '--stdio'],
      source: 'workspace-tsgo',
    });
  });

  it('1. getExePath.js があっても実行ファイルが無ければ次へ', () => {
    expect(resolveLaunch(base([getExe]))).toBeNull();
  });

  it('2. ワークスペースの typescript-language-server は tsserver.js があるときだけ', () => {
    expect(resolveLaunch(base([cli, tsserver]))).toEqual({ command: 'NODE', args: [cli, '--stdio'], source: 'workspace-tls' });
    expect(resolveLaunch(base([cli]))).toBeNull();
  });

  it('3. config の明示指定 (args 省略時は --stdio)', () => {
    expect(resolveLaunch(base([], { config: { mode: 'lsp', command: 'C:\\ls\\cli.mjs' } }))).toEqual({
      command: 'C:\\ls\\cli.mjs',
      args: ['--stdio'],
      source: 'config',
    });
    expect(resolveLaunch(base([], { config: { mode: 'lsp', command: 'X', args: ['--lsp', '--stdio'] } }))?.args).toEqual(['--lsp', '--stdio']);
  });

  it('4. PATH 上の npm global 配置 (.cmd シムではなく cli.mjs の実体を node で起動)', () => {
    const globalCli = path.join('C:\\Users\\me\\AppData\\Roaming\\npm', 'node_modules', 'typescript-language-server', 'lib', 'cli.mjs');
    const r = resolveLaunch(base([globalCli], { env: { PATH: '"C:\\Windows";C:\\Users\\me\\AppData\\Roaming\\npm' } }));
    expect(r).toEqual({ command: 'NODE', args: [globalCli, '--stdio'], source: 'path' });
  });

  it('4. posix の prefix/bin → prefix/lib/node_modules 配置', () => {
    const globalCli = path.join('/usr/local/bin', '..', 'lib', 'node_modules', 'typescript-language-server', 'lib', 'cli.mjs');
    const r = resolveLaunch(base([globalCli], { platform: 'linux', env: { PATH: '/usr/bin:/usr/local/bin' } }));
    expect(r?.source).toBe('path');
    expect(r?.args[0]).toBe(globalCli);
  });

  it('5. 何も無ければ null', () => {
    expect(resolveLaunch(base([]))).toBeNull();
  });
});
