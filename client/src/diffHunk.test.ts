import { describe, expect, it } from 'vitest';
import { hunkStats, parseHunkHeader } from './diffHunk';

describe('parseHunkHeader', () => {
  it('parses a header with explicit line counts on both sides', () => {
    expect(parseHunkHeader('@@ -12,6 +12,7 @@ line11')).toEqual({
      oldStart: 12,
      oldLines: 6,
      newStart: 12,
      newLines: 7,
    });
  });

  it('defaults omitted line counts to 1 (single-line range)', () => {
    expect(parseHunkHeader('@@ -5 +5,2 @@')).toEqual({
      oldStart: 5,
      oldLines: 1,
      newStart: 5,
      newLines: 2,
    });
  });

  it('handles a pure-deletion hunk (newLines: 0)', () => {
    expect(parseHunkHeader('@@ -27,4 +27,0 @@ line26')).toEqual({
      oldStart: 27,
      oldLines: 4,
      newStart: 27,
      newLines: 0,
    });
  });

  it('returns null for a non-hunk-header string', () => {
    expect(parseHunkHeader('not a hunk header')).toBeNull();
  });
});

describe('hunkStats', () => {
  it('counts added and removed lines, ignoring context and no-newline markers', () => {
    expect(
      hunkStats({
        header: '@@ -1,5 +1,5 @@',
        lines: [' line1', '-line2', '+line2-MODIFIED', ' line3', '\\ No newline at end of file'],
      }),
    ).toEqual({ added: 1, removed: 1 });
  });

  it('returns zeros for a hunk with only context lines', () => {
    expect(hunkStats({ header: '@@ -1,3 +1,3 @@', lines: [' a', ' b', ' c'] })).toEqual({
      added: 0,
      removed: 0,
    });
  });
});
