import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { adapterForFile, adapterForType, csharpDefault, resolveLaunchRequest } from './launchConfig.js';

const root = path.resolve('/work/app');
const fsOf = (exists: (abs: string) => boolean, listDir: (abs: string) => string[] = () => []) => ({ exists, listDir });

describe('C# の内蔵既定', () => {
  const proj = path.join(root, 'src', 'App');
  const debugDir = path.join(proj, 'bin', 'Debug');
  const dll = path.join(debugDir, 'net10.0', 'App.dll');
  const fs = fsOf(
    (abs) => abs === dll,
    (abs) => (abs === proj ? ['App.csproj', 'Program.cs'] : abs === debugDir ? ['net8.0', 'net10.0'] : []),
  );
  it('最寄りの .csproj と最新 tfm の dll を program にする', () => {
    expect(csharpDefault(root, path.join(proj, 'Sub', 'Program.cs'), fs)).toEqual({ type: 'coreclr', request: 'launch', name: 'App', program: dll, cwd: proj });
    expect(csharpDefault(root, path.join(root, 'other', 'X.cs'), fs)).toBeNull(); // csproj が無い
    expect(csharpDefault(root, path.join(proj, 'Program.cs'), fsOf(() => false, fs.listDir))).toBeNull(); // 未ビルド
  });
  it('resolveLaunchRequest: 未ビルドは dotnet build を促し、type は coreclr のまま', () => {
    const deps = { readLaunchJson: () => null, ...fs };
    expect(resolveLaunchRequest(root, { file: 'src/App/Program.cs' }, deps, 'csharp')).toMatchObject({ ok: true, config: { type: 'coreclr', program: dll, cwd: proj, console: 'internalConsole' } });
    expect(resolveLaunchRequest(root, { file: 'src/App/Program.cs' }, { ...deps, exists: () => false }, 'csharp')).toMatchObject({ ok: false, error: expect.stringContaining('dotnet build') });
    expect(resolveLaunchRequest(root, { file: 'src/App/Program.cs' }, deps, 'node')).toMatchObject({ ok: false });
  });
  it('type / 拡張子 → アダプター', () => {
    expect(adapterForType('coreclr')).toBe('csharp');
    expect(adapterForType('pwa-node')).toBe('node');
    expect(adapterForType('python')).toBeNull();
    expect(adapterForFile('a/b.cs')).toBe('csharp');
    expect(adapterForFile('a.ts')).toBe('node');
    expect(adapterForFile('a.py')).toBeNull();
  });
});
