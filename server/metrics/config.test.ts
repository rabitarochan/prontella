import { describe, expect, it } from 'vitest';
import { isTier, isUserSettableTier, resolveTier } from './config.js';

// 判別器の真理値表: env と config の全組合せ (正常値・ゴミ値・型違い) で結論と出所を固定する。
describe('resolveTier', () => {
  const cases: [env: unknown, config: unknown, expected: { tier: string; source: string; invalidEnv?: string }][] = [
    [undefined, undefined, { tier: 'off', source: 'default' }],
    ['', undefined, { tier: 'off', source: 'default' }],
    ['   ', undefined, { tier: 'off', source: 'default' }],
    ['dev', undefined, { tier: 'dev', source: 'env' }],
    ['ANON', undefined, { tier: 'anon', source: 'env' }],
    [' off ', { tier: 'dev' }, { tier: 'off', source: 'env' }], // env は config より強い (off でも)
    ['bogus', undefined, { tier: 'off', source: 'default', invalidEnv: 'bogus' }],
    ['bogus', { tier: 'anon' }, { tier: 'anon', source: 'config', invalidEnv: 'bogus' }],
    ['1', { tier: 'dev' }, { tier: 'dev', source: 'config', invalidEnv: '1' }],
    [undefined, { tier: 'anon' }, { tier: 'anon', source: 'config' }],
    [undefined, { tier: 'dev' }, { tier: 'dev', source: 'config' }],
    [undefined, { tier: 'DEV' }, { tier: 'off', source: 'default' }], // config は大文字を許さない
    [undefined, { tier: true }, { tier: 'off', source: 'default' }],
    [undefined, { tier: ['anon'] }, { tier: 'off', source: 'default' }],
    [undefined, 'anon', { tier: 'off', source: 'default' }],
    [undefined, ['anon'], { tier: 'off', source: 'default' }],
    [undefined, null, { tier: 'off', source: 'default' }],
    [undefined, {}, { tier: 'off', source: 'default' }],
    [123, { tier: 'anon' }, { tier: 'anon', source: 'config' }], // env が文字列でなければ無視
  ];

  it.each(cases)('env=%j config=%j → %j', (env, config, expected) => {
    const result = resolveTier(env, config);
    expect(result.tier).toBe(expected.tier);
    expect(result.source).toBe(expected.source);
    expect(result.invalidEnv).toBe(expected.invalidEnv);
  });
});

describe('isTier / isUserSettableTier', () => {
  it('accepts only the three tiers', () => {
    expect(['off', 'anon', 'dev'].every(isTier)).toBe(true);
    expect([undefined, null, '', 'Dev', 'on', 0, {}, ['dev']].some(isTier)).toBe(false);
  });

  it('never lets the API set dev', () => {
    expect(isUserSettableTier('off')).toBe(true);
    expect(isUserSettableTier('anon')).toBe(true);
    expect(isUserSettableTier('dev')).toBe(false);
    expect(isUserSettableTier(['anon'])).toBe(false);
    expect(isUserSettableTier({ toString: () => 'anon' })).toBe(false);
  });
});
