import { describe, expect, it } from 'vitest';
import { ScrollbackBuffer } from './scrollback.js';

/** 決定的な疑似乱数 (テストの再現性のため) */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function chunk(rand: () => number, maxLen: number): string {
  const len = Math.floor(rand() * maxLen);
  let out = '';
  for (let i = 0; i < len; i++) out += String.fromCharCode(0x21 + Math.floor(rand() * 90));
  return out;
}

describe('ScrollbackBuffer', () => {
  it('is empty at start', () => {
    const b = new ScrollbackBuffer(100);
    expect(b.snapshot()).toBe('');
    expect(b.length).toBe(0);
  });

  it('matches the naive slice(-max) implementation over random chunk sequences', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const rand = rng(seed);
      const max = 50 + Math.floor(rand() * 500);
      const b = new ScrollbackBuffer(max);
      let naive = '';
      for (let i = 0; i < 400; i++) {
        const c = chunk(rand, Math.floor(max * 0.6));
        b.append(c);
        naive = (naive + c).slice(-max);
        if (i % 37 === 0) expect(b.snapshot(), `seed ${seed} step ${i}`).toBe(naive);
      }
      expect(b.snapshot()).toBe(naive);
    }
  });

  it('handles a single chunk larger than max', () => {
    const b = new ScrollbackBuffer(10);
    b.append('0123456789ABCDEF');
    expect(b.snapshot()).toBe('6789ABCDEF');
    b.append('xy');
    expect(b.snapshot()).toBe('89ABCDEFxy');
    expect(b.length).toBeLessThan(10 + 3);
  });

  it('keeps at most max + one chunk in memory', () => {
    const max = 1000;
    const b = new ScrollbackBuffer(max);
    const rand = rng(9);
    let largest = 0;
    for (let i = 0; i < 1000; i++) {
      const c = chunk(rand, 300);
      largest = Math.max(largest, c.length);
      b.append(c);
      expect(b.length).toBeLessThanOrEqual(max + largest);
    }
  });

  it('ignores empty appends', () => {
    const b = new ScrollbackBuffer(5);
    b.append('');
    b.append('abc');
    b.append('');
    expect(b.snapshot()).toBe('abc');
  });

  it('rejects a non-positive max', () => {
    expect(() => new ScrollbackBuffer(0)).toThrow(RangeError);
  });
});
