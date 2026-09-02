import { describe, expect, it } from 'vitest';
import { EMPTY_PANE_WIDTHS, paneSplitSizes, sanitizePaneWidths } from './paneWidths';

describe('paneSplitSizes', () => {
  it('未設定なら既定割合を使う', () => {
    expect(paneSplitSizes(null, 20)).toEqual(['20%', '80%']);
  });

  it('設定済みならその割合を使う', () => {
    expect(paneSplitSizes(22.5, 20)).toEqual(['22.5%', '77.5%']);
  });

  it('常に合計 100% になる (Panel の正規化で縮まないための不変条件)', () => {
    for (const pct of [1, 18, 32, 50, 99]) {
      const [a, b] = paneSplitSizes(pct, 20);
      expect(parseFloat(a) + parseFloat(b)).toBeCloseTo(100, 10);
    }
  });
});

describe('sanitizePaneWidths', () => {
  it('オブジェクト以外は全キー未設定', () => {
    for (const raw of [null, undefined, 42, 'x', [], true]) {
      expect(sanitizePaneWidths(raw)).toEqual(EMPTY_PANE_WIDTHS);
    }
  });

  it('正常値はそのまま通す', () => {
    expect(sanitizePaneWidths({ filesTree: 18, gitSide: 20.5, gitChanges: 26 })).toEqual({
      filesTree: 18,
      gitSide: 20.5,
      gitChanges: 26,
    });
  });

  it('欠けているキーは未設定になる', () => {
    expect(sanitizePaneWidths({ filesTree: 18 })).toEqual({
      filesTree: 18,
      gitSide: null,
      gitChanges: null,
    });
  });

  it('壊れた値はそのキーだけ落とし、他のキーは巻き添えにしない', () => {
    const cases: unknown[] = [NaN, Infinity, -Infinity, 0, -5, 100, 120, '30', null, {}];
    for (const bad of cases) {
      expect(sanitizePaneWidths({ filesTree: bad, gitSide: 20, gitChanges: 26 })).toEqual({
        filesTree: null,
        gitSide: 20,
        gitChanges: 26,
      });
    }
  });

  it('範囲の端 (0 と 100) は除外し、その内側は通す', () => {
    expect(sanitizePaneWidths({ filesTree: 0.1 }).filesTree).toBe(0.1);
    expect(sanitizePaneWidths({ filesTree: 99.9 }).filesTree).toBe(99.9);
    expect(sanitizePaneWidths({ filesTree: 0 }).filesTree).toBeNull();
    expect(sanitizePaneWidths({ filesTree: 100 }).filesTree).toBeNull();
  });

  it('知らないキーは無視する', () => {
    expect(sanitizePaneWidths({ filesTree: 18, bogus: 99 })).toEqual({
      filesTree: 18,
      gitSide: null,
      gitChanges: null,
    });
  });
});
