import { describe, expect, it } from 'vitest';
import {
  applyConflictResolution,
  conflictHighlights,
  conflictLenses,
  parseConflictBlocks,
  resolvedBlockLines,
  splitLines,
} from './conflictBlocks';

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

// 行番号は「1-based・閉区間」で返る(Monaco の Range と同じ数え方)。テキストの行番号を
// 目で数えて書けるよう、各テストは lines[] の添字 + 1 が期待値になるように並べてある。
describe('conflictHighlights', () => {
  const at = (text: string) => conflictHighlights(parseConflictBlocks(text));

  it('maps a simple block to ours / theirs ranges and the three marker lines', () => {
    //              1            2        3        4          5          6
    const text = ['<<<<<<< HEAD', 'ours1', 'ours2', '=======', 'theirs1', '>>>>>>> f'].join('\n');
    expect(at(text)).toEqual([
      { startLine: 2, endLine: 3, kind: 'ours' },
      { startLine: 5, endLine: 5, kind: 'theirs' },
      { startLine: 1, endLine: 1, kind: 'marker' },
      { startLine: 4, endLine: 4, kind: 'marker' },
      { startLine: 6, endLine: 6, kind: 'marker' },
    ]);
  });

  it('marks the ||||||| line too in diff3 form, and leaves the base section unpainted', () => {
    //              1          2        3            4       5          6          7
    const text = ['<<<<<<< H', 'ours1', '||||||| b', 'base1', '=======', 'theirs1', '>>>>>>> f'].join('\n');
    const highlights = at(text);
    // base1 (4 行目) はどの範囲にも入らない — resolvedBlockLines がどの kind でも採らないため
    expect(highlights.some((h) => h.startLine <= 4 && 4 <= h.endLine)).toBe(false);
    expect(highlights.filter((h) => h.kind === 'marker').map((h) => h.startLine).sort((a, b) => a - b)).toEqual([
      1, 3, 5, 7,
    ]);
    expect(highlights.filter((h) => h.kind !== 'marker')).toEqual([
      { startLine: 2, endLine: 2, kind: 'ours' },
      { startLine: 6, endLine: 6, kind: 'theirs' },
    ]);
  });

  it('emits no range for an empty side (add vs delete conflicts)', () => {
    //                 1          2          3         4
    const oursEmpty = ['<<<<<<<', '=======', 'theirs', '>>>>>>>'].join('\n');
    expect(at(oursEmpty).filter((h) => h.kind === 'ours')).toEqual([]);
    expect(at(oursEmpty).filter((h) => h.kind === 'theirs')).toEqual([
      { startLine: 3, endLine: 3, kind: 'theirs' },
    ]);

    const theirsEmpty = ['<<<<<<<', 'ours', '=======', '>>>>>>>'].join('\n');
    expect(at(theirsEmpty).filter((h) => h.kind === 'theirs')).toEqual([]);
    expect(at(theirsEmpty).filter((h) => h.kind === 'ours')).toEqual([
      { startLine: 2, endLine: 2, kind: 'ours' },
    ]);
    // 両側が空でもマーカー 3 行は必ず出る (解決すべき箇所が画面から消えないように)
    expect(at(['<<<<<<<', '=======', '>>>>>>>'].join('\n'))).toEqual([
      { startLine: 1, endLine: 1, kind: 'marker' },
      { startLine: 2, endLine: 2, kind: 'marker' },
      { startLine: 3, endLine: 3, kind: 'marker' },
    ]);
  });

  it('offsets ranges by the leading text and handles multiple blocks', () => {
    const text = [
      'a', 'b', //                                1, 2
      '<<<<<<<', 'ours1', '=======', 'theirs1', '>>>>>>>', // 3..7
      'c', //                                    8
      '<<<<<<<', 'ours2', '=======', 'theirs2', '>>>>>>>', // 9..13
    ].join('\n');
    expect(at(text).filter((h) => h.kind !== 'marker')).toEqual([
      { startLine: 4, endLine: 4, kind: 'ours' },
      { startLine: 6, endLine: 6, kind: 'theirs' },
      { startLine: 10, endLine: 10, kind: 'ours' },
      { startLine: 12, endLine: 12, kind: 'theirs' },
    ]);
  });

  it('returns nothing when there are no blocks', () => {
    expect(conflictHighlights([])).toEqual([]);
    expect(at('just\nplain\ntext')).toEqual([]);
  });
});

describe('conflictLenses', () => {
  it('puts every kind on the block opening line, tagged with the block index', () => {
    const text = [
      'x', //                                     1
      '<<<<<<<', 'ours1', '=======', 'theirs1', '>>>>>>>', // 2..6
      '<<<<<<<', 'ours2', '=======', 'theirs2', '>>>>>>>', // 7..11
    ].join('\n');
    const blocks = parseConflictBlocks(text);
    expect(conflictLenses(blocks, ['ours', 'theirs', 'both'])).toEqual([
      { line: 2, blockIndex: 0, kind: 'ours' },
      { line: 2, blockIndex: 0, kind: 'theirs' },
      { line: 2, blockIndex: 0, kind: 'both' },
      { line: 7, blockIndex: 1, kind: 'ours' },
      { line: 7, blockIndex: 1, kind: 'theirs' },
      { line: 7, blockIndex: 1, kind: 'both' },
    ]);
  });

  it('keeps blockIndex aligned with the blocks array — it is what the apply command replaces', () => {
    const text = [
      '<<<<<<<', 'a-ours', '=======', 'a-theirs', '>>>>>>>',
      '<<<<<<<', 'b-ours', '=======', 'b-theirs', '>>>>>>>',
    ].join('\n');
    const blocks = parseConflictBlocks(text);
    for (const lens of conflictLenses(blocks, ['ours'])) {
      // lens を引いたときに置換されるのは、その lens が乗っている行のブロック
      expect(blocks[lens.blockIndex].startLine + 1).toBe(lens.line);
    }
  });

  it('returns nothing for no blocks or no kinds', () => {
    const blocks = parseConflictBlocks(['<<<<<<<', 'o', '=======', 't', '>>>>>>>'].join('\n'));
    expect(conflictLenses([], ['ours'])).toEqual([]);
    expect(conflictLenses(blocks, [])).toEqual([]);
  });
});
