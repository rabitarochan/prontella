import { describe, expect, it } from 'vitest';
import { MAX_COLS, MAX_ROWS, MIN_COLS, MIN_ROWS, parseResizeMessage } from './termProtocol.js';

describe('parseResizeMessage', () => {
  it('accepts an integer size inside the range', () => {
    expect(parseResizeMessage({ type: 'resize', cols: 120, rows: 32 })).toEqual({ cols: 120, rows: 32 });
    expect(parseResizeMessage({ cols: MIN_COLS, rows: MIN_ROWS })).toEqual({ cols: MIN_COLS, rows: MIN_ROWS });
    expect(parseResizeMessage({ cols: MAX_COLS, rows: MAX_ROWS })).toEqual({ cols: MAX_COLS, rows: MAX_ROWS });
  });

  it('rejects non-objects and missing fields', () => {
    expect(parseResizeMessage(null)).toBeNull();
    expect(parseResizeMessage('resize')).toBeNull();
    expect(parseResizeMessage(42)).toBeNull();
    expect(parseResizeMessage({})).toBeNull();
    expect(parseResizeMessage({ cols: 80 })).toBeNull();
    expect(parseResizeMessage({ rows: 24 })).toBeNull();
    expect(parseResizeMessage([80, 24])).toBeNull();
  });

  it('rejects non-integer and non-number values', () => {
    expect(parseResizeMessage({ cols: '80', rows: 24 })).toBeNull();
    expect(parseResizeMessage({ cols: 80, rows: '24' })).toBeNull();
    expect(parseResizeMessage({ cols: 80.5, rows: 24 })).toBeNull();
    expect(parseResizeMessage({ cols: 80, rows: Number.NaN })).toBeNull();
    expect(parseResizeMessage({ cols: Number.POSITIVE_INFINITY, rows: 24 })).toBeNull();
    expect(parseResizeMessage({ cols: true, rows: 24 })).toBeNull();
  });

  it('rejects sizes outside the range', () => {
    expect(parseResizeMessage({ cols: 0, rows: 24 })).toBeNull();
    expect(parseResizeMessage({ cols: 1, rows: 24 })).toBeNull();
    expect(parseResizeMessage({ cols: -80, rows: 24 })).toBeNull();
    expect(parseResizeMessage({ cols: 80, rows: 0 })).toBeNull();
    expect(parseResizeMessage({ cols: MAX_COLS + 1, rows: 24 })).toBeNull();
    expect(parseResizeMessage({ cols: 80, rows: MAX_ROWS + 1 })).toBeNull();
  });
});
