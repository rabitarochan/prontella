import { describe, expect, it } from 'vitest';
import { classifyDiffLine } from './stashDiffText';

describe('classifyDiffLine', () => {
  it('classifies file header lines as meta', () => {
    expect(classifyDiffLine('diff --git a/foo.txt b/foo.txt')).toBe('meta');
    expect(classifyDiffLine('index 0b6d934..c012a41 100644')).toBe('meta');
    expect(classifyDiffLine('--- a/foo.txt')).toBe('meta');
    expect(classifyDiffLine('+++ b/foo.txt')).toBe('meta');
    expect(classifyDiffLine('\\ No newline at end of file')).toBe('meta');
  });

  it('classifies a hunk header line', () => {
    expect(classifyDiffLine('@@ -1,3 +1,4 @@')).toBe('hunk');
  });

  it('classifies added and removed content lines', () => {
    expect(classifyDiffLine('+new line')).toBe('add');
    expect(classifyDiffLine('-old line')).toBe('del');
  });

  it('classifies context lines (leading space or otherwise unmarked)', () => {
    expect(classifyDiffLine(' unchanged line')).toBe('context');
    expect(classifyDiffLine('')).toBe('context');
  });

  it('prefers the file-header check over the generic +/- check (order matters)', () => {
    // "+++ " (with trailing space) must win over the generic '+' add-line check even
    // though it also starts with '+'.
    expect(classifyDiffLine('+++ b/some-file.txt')).toBe('meta');
    expect(classifyDiffLine('--- a/some-file.txt')).toBe('meta');
  });
});
