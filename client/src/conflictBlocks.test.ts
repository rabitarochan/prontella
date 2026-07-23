import { describe, expect, it } from 'vitest';
import { applyConflictResolution, parseConflictBlocks, resolvedBlockLines, splitLines } from './conflictBlocks';

describe('parseConflictBlocks', () => {
  it('parses a simple (non-diff3) conflict block', () => {
    const text = ['a', '<<<<<<< HEAD', 'ours1', 'ours2', '=======', 'theirs1', '>>>>>>> feature', 'b'].join(
      '\n',
    );
    const blocks = parseConflictBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      startLine: 1,
      endLine: 6,
      oursStart: 2,
      oursEnd: 4,
      theirsStart: 5,
      theirsEnd: 6,
      oursLabel: 'HEAD',
      theirsLabel: 'feature',
      hasBase: false,
    });
  });

  it('parses a diff3-style block with a common-ancestor (|||||||) section', () => {
    const text = [
      '<<<<<<< HEAD',
      'ours1',
      '||||||| base',
      'base1',
      'base2',
      '=======',
      'theirs1',
      'theirs2',
      '>>>>>>> feature',
    ].join('\n');
    const blocks = parseConflictBlocks(text);
    expect(blocks).toHaveLength(1);
    const b = blocks[0];
    expect(b.hasBase).toBe(true);
    // ours は <<<<<<< と ||||||| の間だけ (base 行は含まない)
    expect(resolvedBlockLines(splitLines(text), b, 'ours')).toEqual(['ours1']);
    expect(resolvedBlockLines(splitLines(text), b, 'theirs')).toEqual(['theirs1', 'theirs2']);
  });

  it('finds multiple independent blocks in the same file', () => {
    const text = [
      '<<<<<<<',
      'a-ours',
      '=======',
      'a-theirs',
      '>>>>>>>',
      'context',
      '<<<<<<<',
      'b-ours',
      '=======',
      'b-theirs',
      '>>>>>>>',
    ].join('\n');
    const blocks = parseConflictBlocks(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].startLine).toBe(0);
    expect(blocks[1].startLine).toBe(6);
  });

  it('ignores a broken block with no closing marker', () => {
    const text = ['<<<<<<< HEAD', 'ours1', '======='].join('\n'); // missing >>>>>>>
    expect(parseConflictBlocks(text)).toEqual([]);
  });

  it('ignores a start marker immediately followed by another start marker', () => {
    const text = ['<<<<<<< HEAD', '<<<<<<< nested', 'x', '=======', 'y', '>>>>>>>'].join('\n');
    // 最初の '<<<<<<< HEAD' は対応する終端が見つからず破棄され、2 つ目から改めて
    // 正常なブロックとして拾われる。
    const blocks = parseConflictBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].startLine).toBe(1);
  });

  it('returns no blocks for text without conflict markers', () => {
    expect(parseConflictBlocks('a\nb\nc')).toEqual([]);
  });

  it('handles CRLF line endings the same as LF', () => {
    const text = ['<<<<<<< HEAD', 'ours1', '=======', 'theirs1', '>>>>>>> feature'].join('\r\n');
    const blocks = parseConflictBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].endLine).toBe(4);
  });
});

describe('resolvedBlockLines', () => {
  const text = ['<<<<<<<', 'ours1', 'ours2', '=======', 'theirs1', '>>>>>>>'].join('\n');
  const block = parseConflictBlocks(text)[0];
  const lines = splitLines(text);

  it('returns only the ours lines for kind=ours', () => {
    expect(resolvedBlockLines(lines, block, 'ours')).toEqual(['ours1', 'ours2']);
  });

  it('returns only the theirs lines for kind=theirs', () => {
    expect(resolvedBlockLines(lines, block, 'theirs')).toEqual(['theirs1']);
  });

  it('concatenates ours then theirs for kind=both', () => {
    expect(resolvedBlockLines(lines, block, 'both')).toEqual(['ours1', 'ours2', 'theirs1']);
  });
});

describe('applyConflictResolution', () => {
  it('replaces the whole block (markers included) with the resolved lines, keeping surrounding text', () => {
    const text = ['before', '<<<<<<<', 'ours1', '=======', 'theirs1', '>>>>>>>', 'after'].join('\n');
    const block = parseConflictBlocks(text)[0];
    expect(applyConflictResolution(text, block, 'ours')).toBe('before\nours1\nafter');
    expect(applyConflictResolution(text, block, 'theirs')).toBe('before\ntheirs1\nafter');
    expect(applyConflictResolution(text, block, 'both')).toBe('before\nours1\ntheirs1\nafter');
  });

  it('resolving one block leaves other blocks untouched', () => {
    const text = ['<<<<<<<', 'a-ours', '=======', 'a-theirs', '>>>>>>>', '<<<<<<<', 'b-ours', '=======', 'b-theirs', '>>>>>>>'].join(
      '\n',
    );
    const [first] = parseConflictBlocks(text);
    const result = applyConflictResolution(text, first, 'ours');
    expect(result).toBe(['a-ours', '<<<<<<<', 'b-ours', '=======', 'b-theirs', '>>>>>>>'].join('\n'));
    // 2 番目のブロックは元のまま残っている
    expect(parseConflictBlocks(result)).toHaveLength(1);
  });
});
