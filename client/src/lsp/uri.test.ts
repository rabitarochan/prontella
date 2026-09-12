import { describe, expect, it } from 'vitest';
import { modelUriString, parseModelUri, parseWireUri, toWireUri } from './uri';

describe('parseModelUri', () => {
  it('第 1 セグメントが leafId、残りが path (デコード済み)', () => {
    expect(parseModelUri('file:///leaf1/src/a%20b/%E6%97%A5%E6%9C%AC.ts')).toEqual({ leafId: 'leaf1', path: 'src/a b/日本.ts' });
  });
  it('競合解決ペインなどは呼び出し側が leafId 一致で除外できる形で返す', () => {
    expect(parseModelUri('file:///leaf1-conflict/src/a.ts')).toEqual({ leafId: 'leaf1-conflict', path: 'src/a.ts' });
  });
  it('形が違えば null', () => {
    expect(parseModelUri('inmemory://model/1')).toBeNull();
    expect(parseModelUri('file:///leaf1')).toBeNull();
    expect(parseModelUri('file:///leaf1//a.ts')).toBeNull();
    expect(parseModelUri('file:///leaf1/%E0%A4%A')).toBeNull();
  });
  it('modelUriString と往復する', () => {
    const s = modelUriString('leaf 1', 'src/a b/日本.ts');
    expect(parseModelUri(s)).toEqual({ leafId: 'leaf 1', path: 'src/a b/日本.ts' });
  });
});

describe('toWireUri / parseWireUri', () => {
  it('root 配下', () => {
    const w = toWireUri('r1', 'src/a b/日本.ts');
    expect(w).toBe('file:///r1/src/a%20b/%E6%97%A5%E6%9C%AC.ts');
    expect(parseWireUri('r1', w)).toEqual({ kind: 'file', path: 'src/a b/日本.ts' });
  });
  it('root 外は external (name だけ)', () => {
    expect(parseWireUri('r1', 'file:///r1-ext/e1/lib.dom.d.ts')).toEqual({ kind: 'external', name: 'lib.dom.d.ts' });
  });
  it('別トークン・不正は null', () => {
    expect(parseWireUri('r1', 'file:///r2/src/a.ts')).toBeNull();
    expect(parseWireUri('r1', 'file:///r1//a.ts')).toBeNull();
    expect(parseWireUri('r1', 'file:///C:/x.ts')).toBeNull();
  });
});
