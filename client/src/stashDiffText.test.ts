import { describe, expect, it } from 'vitest';
import { classifyDiffLine, MAX_STASH_DIFF_TEXT_LENGTH, truncateStashDiffText } from './stashDiffText';

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

describe('truncateStashDiffText', () => {
  it('leaves short text untouched', () => {
    const text = 'diff --git a/foo b/foo\n+one\n-two\n';
    expect(truncateStashDiffText(text)).toEqual({ text, truncated: false });
  });

  it('cuts oversized text at the last newline at or before the limit', () => {
    // Lines of length 10 (including '\n') so the cut boundary lands predictably.
    const line = 'x'.repeat(9) + '\n';
    const lineCount = Math.ceil(MAX_STASH_DIFF_TEXT_LENGTH / line.length) + 5;
    const text = line.repeat(lineCount);
    const { text: shown, truncated } = truncateStashDiffText(text);
    expect(truncated).toBe(true);
    expect(shown.length).toBeLessThanOrEqual(MAX_STASH_DIFF_TEXT_LENGTH);
    // The cut must land exactly on a line boundary (no partial line at the end).
    expect(shown.endsWith('x')).toBe(true);
    expect(text.startsWith(shown)).toBe(true);
  });

  it('falls back to a hard cut when no newline exists within the limit', () => {
    const text = 'x'.repeat(MAX_STASH_DIFF_TEXT_LENGTH + 100);
    const { text: shown, truncated } = truncateStashDiffText(text);
    expect(truncated).toBe(true);
    expect(shown.length).toBe(MAX_STASH_DIFF_TEXT_LENGTH);
  });

  it('falls back to a hard cut when the only newline within the limit is at index 0', () => {
    // Degenerate case: text starts with '\n' and has no other newline before the limit.
    // lastIndexOf('\n', MAX) returns 0 here, which must NOT be treated as a valid cut
    // point (slice(0, 0) would produce an empty string instead of any visible content).
    const text = '\n' + 'x'.repeat(MAX_STASH_DIFF_TEXT_LENGTH + 100);
    const { text: shown, truncated } = truncateStashDiffText(text);
    expect(truncated).toBe(true);
    expect(shown.length).toBe(MAX_STASH_DIFF_TEXT_LENGTH);
    expect(shown).not.toBe('');
  });
});
