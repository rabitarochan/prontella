import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig, parseLaunchConfigs, resolveLaunchRequest, stripJsonc, substituteVariables } from './launchConfig.js';

const root = path.resolve('/work/app');

describe('stripJsonc', () => {
  it('コメントと末尾カンマと BOM を落とし、文字列の中は触らない', () => {
    const src = '﻿{\n  // c1\n  "a": "x // not comment", /* c2 */\n  "b": [1, 2,],\n  "c": "y,]",\n}\n';
    expect(JSON.parse(stripJsonc(src))).toEqual({ a: 'x // not comment', b: [1, 2], c: 'y,]' });
  });
  it('エスケープした引用符を含む文字列', () => {
    expect(JSON.parse(stripJsonc('{"a": "q\\"//x", }'))).toEqual({ a: 'q"//x' });
  });
});

describe('parseLaunchConfigs', () => {
  it('node 系だけ拾い、不正な 1 件は warnings に回す', () => {
    const text = JSON.stringify({
      version: '0.2.0',
      configurations: [
        { type: 'pwa-node', request: 'launch', name: 'A', program: '${workspaceFolder}/a.js' },
        { type: 'coreclr', request: 'launch', name: 'CS' },
        { type: 'node', request: 'bogus', name: 'B' },
        { type: 'node', request: 'attach', name: 'C', port: 9229 },
        { type: 'node', request: 'launch', name: 'D', env: { X: 'a\u0000b' } },
        'not an object',
      ],
    });
    const r = parseLaunchConfigs(text);
    expect(r.configs.map((c) => c.name)).toEqual(['A', 'C']);
    expect(r.warnings).toHaveLength(3);
  });
  it('壊れた JSON / configurations 無し', () => {
    expect(parseLaunchConfigs('{').configs).toEqual([]);
    expect(parseLaunchConfigs('{"a":1}').warnings[0]).toMatch(/configurations/);
  });
});

describe('substituteVariables', () => {
  it('workspaceFolder と file を埋める', () => {
    const r = substituteVariables({ program: '${workspaceFolder}/x', args: ['${file}'], n: 1 }, { workspaceFolder: 'R', file: 'F' });
    expect(r).toEqual({ ok: true, value: { program: 'R/x', args: ['F'], n: 1 } });
  });
  it('file 無しで ${file} / 未知の変数はエラー', () => {
    expect(substituteVariables({ p: '${file}' }, { workspaceFolder: 'R' })).toMatchObject({ ok: false });
    expect(substituteVariables({ p: '${env:HOME}' }, { workspaceFolder: 'R' })).toMatchObject({ ok: false, error: expect.stringContaining('env:HOME') });
  });
});

describe('defaultConfig', () => {
  it('.js は node、.ts は tsx がある root だけ', () => {
    expect(defaultConfig(root, path.join(root, 'a.js'), () => false)).toMatchObject({ type: 'pwa-node', program: path.join(root, 'a.js'), cwd: root });
    expect(defaultConfig(root, path.join(root, 'a.ts'), () => false)).toBeNull();
    expect(defaultConfig(root, path.join(root, 'a.ts'), () => true)).toMatchObject({ runtimeArgs: ['--import', 'tsx'] });
    expect(defaultConfig(root, path.join(root, 'a.py'), () => true)).toBeNull();
  });
});

describe('resolveLaunchRequest', () => {
  const launchJson = JSON.stringify({ configurations: [{ type: 'node', request: 'launch', name: 'A', program: '${file}', console: 'integratedTerminal' }] });
  const deps = { readLaunchJson: () => launchJson, exists: () => true };
  it('name で launch.json を引き、file を埋め、console を上書きする', () => {
    const r = resolveLaunchRequest(root, { name: 'A', file: 'src/a.js' }, deps);
    expect(r).toEqual({ ok: true, config: { cwd: root, type: 'pwa-node', request: 'launch', name: 'A', program: path.join(root, 'src', 'a.js'), console: 'internalConsole' } });
  });
  it('file だけなら内蔵既定', () => {
    const r = resolveLaunchRequest(root, { file: 'a.js' }, deps);
    expect(r).toMatchObject({ ok: true, config: { type: 'pwa-node', program: path.join(root, 'a.js'), console: 'internalConsole' } });
  });
  it('root 外・未知の name・型違いは拒否', () => {
    expect(resolveLaunchRequest(root, { file: '../etc/passwd' }, deps)).toMatchObject({ ok: false });
    expect(resolveLaunchRequest(root, { name: 'nope' }, deps)).toMatchObject({ ok: false });
    expect(resolveLaunchRequest(root, { name: 42 }, deps)).toMatchObject({ ok: false });
    expect(resolveLaunchRequest(root, {}, deps)).toMatchObject({ ok: false });
    expect(resolveLaunchRequest(root, { name: 'A' }, { ...deps, readLaunchJson: () => null })).toMatchObject({ ok: false });
  });
});
