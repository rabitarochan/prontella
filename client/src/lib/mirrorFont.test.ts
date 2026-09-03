import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SOLVE_OPTIONS,
  MIRROR_FONT_MAX,
  MIRROR_FONT_MIN,
  mirrorScale,
  solveMirrorFontSize,
  type GridSize,
} from './mirrorFont';

describe('mirrorScale', () => {
  it('is 1 when the grid already fits', () => {
    expect(mirrorScale({ width: 500, height: 300 }, { width: 400, height: 300 })).toBe(1);
  });

  it('shrinks by the tighter axis when the grid overflows', () => {
    expect(mirrorScale({ width: 438, height: 340 }, { width: 1052, height: 344 })).toBeCloseTo(438 / 1052, 6);
    expect(mirrorScale({ width: 1000, height: 100 }, { width: 500, height: 400 })).toBeCloseTo(0.25, 6);
  });

  it('is 1 for a degenerate box or screen', () => {
    expect(mirrorScale({ width: 0, height: 300 }, { width: 400, height: 300 })).toBe(1);
    expect(mirrorScale({ width: 400, height: 300 }, { width: 0, height: 0 })).toBe(1);
  });
});

// xterm のセル寸法モデル (単調・丸めあり): 幅 = cols × round(fs × 0.6)、高さ = rows × ceil(fs × 1.2)
function grid(cols: number, rows: number) {
  return (fs: number): GridSize => ({
    width: cols * Math.round(fs * 0.6),
    height: rows * Math.ceil(fs * 1.2),
  });
}

function counting(probe: (fs: number) => GridSize | null) {
  const calls: number[] = [];
  return {
    calls,
    probe: (fs: number) => {
      calls.push(fs);
      return probe(fs);
    },
  };
}

function largestFitting(probe: (fs: number) => GridSize, box: { width: number; height: number }): number {
  for (let fs = MIRROR_FONT_MAX; fs >= MIRROR_FONT_MIN; fs--) {
    const s = probe(fs);
    if (s.width <= box.width && s.height <= box.height) return fs;
  }
  return MIRROR_FONT_MIN;
}

describe('solveMirrorFontSize', () => {
  it('returns null for an unlaid-out box', () => {
    const { probe } = counting(grid(120, 32));
    expect(solveMirrorFontSize({ width: 0, height: 0 }, { fontSize: 13, screen: null }, probe)).toBeNull();
    expect(solveMirrorFontSize({ width: 400, height: 0 }, { fontSize: 13, screen: null }, probe)).toBeNull();
  });

  it('returns null when the initial measurement fails', () => {
    expect(solveMirrorFontSize({ width: 400, height: 300 }, { fontSize: 13, screen: null }, () => null)).toBeNull();
    expect(
      solveMirrorFontSize({ width: 400, height: 300 }, { fontSize: 13, screen: { width: 0, height: 0 } }, () => null),
    ).toBeNull();
  });

  it('picks the largest fitting size for a range of boxes (matches brute force)', () => {
    const model = grid(120, 32);
    for (const width of [300, 420, 500, 640, 800, 936, 1200]) {
      for (const height of [150, 200, 260, 340, 500]) {
        const box = { width, height };
        const { probe } = counting(model);
        const got = solveMirrorFontSize(box, { fontSize: 13, screen: null }, probe);
        expect(got, `${width}x${height}`).toBe(largestFitting(model, box));
      }
    }
  });

  it('never enlarges beyond max even when the box is huge', () => {
    const { probe } = counting(grid(60, 15));
    expect(solveMirrorFontSize({ width: 4000, height: 3000 }, { fontSize: 13, screen: null }, probe)).toBe(
      MIRROR_FONT_MAX,
    );
  });

  it('returns min when even the smallest font overflows', () => {
    const { probe } = counting(grid(400, 100));
    expect(solveMirrorFontSize({ width: 300, height: 100 }, { fontSize: 13, screen: null }, probe)).toBe(
      MIRROR_FONT_MIN,
    );
  });

  it('uses the supplied current screen size instead of probing it', () => {
    const model = grid(120, 32);
    const { probe, calls } = counting(model);
    const box = { width: 936, height: 500 }; // 13 では 120×8=960 > 936 なので縮める側の経路
    solveMirrorFontSize(box, { fontSize: 13, screen: model(13) }, probe);
    expect(calls).not.toContain(13);
  });

  it('stays within the probe budget', () => {
    const model = grid(120, 32);
    for (const width of [300, 500, 800, 1200]) {
      const { probe, calls } = counting(model);
      solveMirrorFontSize({ width, height: 260 }, { fontSize: 13, screen: null }, probe);
      expect(calls.length).toBeLessThanOrEqual(DEFAULT_SOLVE_OPTIONS.maxProbes);
    }
  });

  it('is non-decreasing as the box grows', () => {
    const model = grid(120, 32);
    let prev = 0;
    for (let width = 200; width <= 1400; width += 40) {
      const { probe } = counting(model);
      const got = solveMirrorFontSize({ width, height: 400 }, { fontSize: 13, screen: null }, probe);
      expect(got).not.toBeNull();
      expect(got!).toBeGreaterThanOrEqual(prev);
      prev = got!;
    }
  });

  it('starts from the current (already shrunk) font size and can grow back', () => {
    const model = grid(120, 32);
    const { probe } = counting(model);
    const got = solveMirrorFontSize({ width: 1200, height: 600 }, { fontSize: 7, screen: model(7) }, probe);
    expect(got).toBe(largestFitting(model, { width: 1200, height: 600 }));
  });
});
