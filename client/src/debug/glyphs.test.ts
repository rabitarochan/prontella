import { describe, expect, it } from 'vitest';
import { buildDecorations } from './glyphs';

describe('buildDecorations', () => {
  it('実行中: 検証済みは塗り、未検証/応答前は hollow、範囲外は捨てる。現在行は whole-line', () => {
    const out = buildDecorations([2, 5, 99], { 2: { id: 1, verified: true, line: 2 } }, 5, 10, true);
    expect(out.map((d) => [d.range.startLineNumber, d.options.glyphMarginClassName, d.options.isWholeLine ?? false])).toEqual([
      [2, 'debug-bp-glyph', false],
      [5, 'debug-bp-glyph unverified', false],
      [5, 'debug-current-glyph', true],
    ]);
    expect(buildDecorations([], undefined, null, 3)).toEqual([]);
    expect(buildDecorations([], undefined, 4, 3)).toEqual([]);
  });
  it('実行していないときは検証状態に関係なく塗る (VS Code と同じ)', () => {
    expect(buildDecorations([1], undefined, null, 3).map((d) => d.options.glyphMarginClassName)).toEqual(['debug-bp-glyph']);
    expect(buildDecorations([1], { 1: { id: 1, verified: false, line: 1 } }, null, 3, false).map((d) => d.options.glyphMarginClassName)).toEqual(['debug-bp-glyph']);
  });
});
