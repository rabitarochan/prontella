import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkLspConfig, findSolution, languageIdFor, resolveLaunch, serverIdFor, type ResolveEnv } from './registry.js';

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

  it('serverIdFor: C# だけ csharp、残りは typescript', () => {
    expect(serverIdFor('javascriptreact')).toBe('typescript');
    expect(serverIdFor('csharp')).toBe('csharp');
    expect(languageIdFor('src/Program.cs')).toBe('csharp');
    expect(languageIdFor('script.csx')).toBeNull();
  });
});

describe('checkLspConfig', () => {
  const DEFAULTS = { typescript: { mode: 'builtin' }, csharp: { mode: 'lsp' } };
  it('未指定は TS builtin / C# lsp', () => {
    expect(checkLspConfig(undefined)).toEqual({ ok: true, config: DEFAULTS });
    expect(checkLspConfig(null)).toEqual({ ok: true, config: DEFAULTS });
    expect(checkLspConfig({})).toEqual({ ok: true, config: DEFAULTS });
  });

  it('mode の値域はサーバーごと', () => {
    expect(checkLspConfig({ csharp: { mode: 'off' } })).toEqual({ ok: true, config: { ...DEFAULTS, csharp: { mode: 'off' } } });
    expect(checkLspConfig({ csharp: { mode: 'builtin' } }).ok).toBe(false);
    expect(checkLspConfig({ typescript: { mode: 'off' } }).ok).toBe(false);
    expect(checkLspConfig({ csharp: [] }).ok).toBe(false);
  });

  it('配列・文字列・数値は弾く (typeof を先に見る)', () => {
    expect(checkLspConfig([]).ok).toBe(false);
    expect(checkLspConfig('lsp').ok).toBe(false);
    expect(checkLspConfig({ typescript: [] }).ok).toBe(false);
    expect(checkLspConfig({ typescript: 'lsp' }).ok).toBe(false);
  });

  it('mode の値域', () => {
    expect(checkLspConfig({ typescript: { mode: 'lsp' } })).toEqual({ ok: true, config: { ...DEFAULTS, typescript: { mode: 'lsp' } } });
    expect(checkLspConfig({ typescript: { mode: 'on' } }).ok).toBe(false);
    expect(checkLspConfig({ typescript: { mode: true } }).ok).toBe(false);
  });

  it('command / args は制御文字を拒否', () => {
    expect(checkLspConfig({ typescript: { command: 'C:\\x\\cli.mjs', args: ['--stdio'] } })).toEqual({
      ok: true,
      config: { ...DEFAULTS, typescript: { mode: 'builtin', command: 'C:\\x\\cli.mjs', args: ['--stdio'] } },
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
  const home = path.resolve('/home/me');
  const base = (exists: string[], extra: Partial<ResolveEnv> = {}, dirs: Record<string, string[]> = {}): ResolveEnv => ({
    root,
    serverId: 'typescript',
    config: { mode: 'lsp' },
    env: { PATH: '' },
    platform: 'win32',
    arch: 'x64',
    execPath: 'NODE',
    home,
    tmpDir: path.resolve('/tmp'),
    pid: 4242,
    exists: (p) => exists.map((e) => path.resolve(e)).includes(path.resolve(p)),
    listDir: (p) => dirs[path.resolve(p)] ?? [],
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

  describe('csharp (Roslyn LS)', () => {
    const extDir = path.join(home, '.vscode', 'extensions');
    const exe = (ver: string) => path.join(extDir, `ms-dotnettools.csharp-${ver}-win32-x64`, '.roslyn', 'Microsoft.CodeAnalysis.LanguageServer.exe');
    const logDir = path.join(path.resolve('/tmp'), 'prontella-roslyn');
    const defaultArgs = ['--stdio', '--logLevel', 'Information', '--extensionLogDirectory', logDir, '--clientProcessId', '4242'];
    const cs = (exists: string[], extra: Partial<ResolveEnv> = {}, dirs: Record<string, string[]> = {}) => base(exists, { serverId: 'csharp', ...extra }, dirs);

    it('1. config の明示指定 (args 省略時は Roslyn の既定引数)', () => {
      expect(resolveLaunch(cs([], { config: { mode: 'lsp', command: 'C:\\ls\\x.exe' } }))).toEqual({ command: 'C:\\ls\\x.exe', args: defaultArgs, source: 'config', logDir });
      expect(resolveLaunch(cs([], { config: { mode: 'lsp', command: 'X', args: ['--stdio'] } }))?.args).toEqual(['--stdio']);
    });

    it('2. VS Code C# 拡張は新しい版から、実行ファイルがあるものだけ', () => {
      const dirs = { [extDir]: ['ms-dotnettools.csharp-2.140.9-win32-x64', 'ms-dotnettools.csdevkit-3.2.0-win32-x64', 'ms-dotnettools.csharp-2.150.1-win32-x64'] };
      expect(resolveLaunch(cs([exe('2.140.9'), exe('2.150.1')], {}, dirs))).toEqual({ command: exe('2.150.1'), args: defaultArgs, source: 'vscode-ext', logDir });
      // 最新版のディレクトリーに実体が無ければ次の版
      expect(resolveLaunch(cs([exe('2.140.9')], {}, dirs))?.command).toBe(exe('2.140.9'));
    });

    it('3. PATH 上の roslyn-language-server、4. ~/.dotnet/tools', () => {
      const onPath = path.join('C:\\tools', 'roslyn-language-server.exe');
      expect(resolveLaunch(cs([onPath], { env: { PATH: 'C:\\Windows;"C:\\tools"' } }))).toEqual({ command: onPath, args: defaultArgs, source: 'path', logDir });
      const tool = path.join(home, '.dotnet', 'tools', 'roslyn-language-server.exe');
      expect(resolveLaunch(cs([tool]))).toEqual({ command: tool, args: defaultArgs, source: 'dotnet-tool', logDir });
    });

    it('5. 無ければ null。TS の解決は C# の候補を拾わない', () => {
      expect(resolveLaunch(cs([]))).toBeNull();
      const tool = path.join(home, '.dotnet', 'tools', 'roslyn-language-server.exe');
      expect(resolveLaunch(base([tool]))).toBeNull();
    });
  });
});

describe('findSolution', () => {
  const root = path.resolve('/repo');
  const dirs: Record<string, string[]> = {
    [path.join(root, 'mss3-backend')]: ['MSS3.sln', 'src'],
    [path.join(root, 'bss-backend')]: ['BSS.sln', 'src'],
    [path.join(root, 'multi')]: ['b.sln', 'a.slnx', 'src'],
    [root]: ['mss3-backend', 'bss-backend', 'multi', 'loose'],
  };
  const listDir = (p: string) => dirs[path.resolve(p)] ?? [];

  it('ファイルのディレクトリーから root へ遡って最初の .sln', () => {
    expect(findSolution(root, path.join(root, 'mss3-backend', 'src', 'App', 'A.cs'), listDir)).toBe(path.join(root, 'mss3-backend', 'MSS3.sln'));
    expect(findSolution(root, path.join(root, 'bss-backend', 'src', 'B.cs'), listDir)).toBe(path.join(root, 'bss-backend', 'BSS.sln'));
  });
  it('同じディレクトリーに複数あれば名前順の先頭 (.slnx も対象)', () => {
    expect(findSolution(root, path.join(root, 'multi', 'src', 'C.cs'), listDir)).toBe(path.join(root, 'multi', 'a.slnx'));
  });
  it('root まで無ければ null。root の外へは出ない', () => {
    expect(findSolution(root, path.join(root, 'loose', 'D.cs'), listDir)).toBeNull();
    expect(findSolution(root, path.join(root, '..', 'outside', 'E.cs'), listDir)).toBeNull();
  });
});
