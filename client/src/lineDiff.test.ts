import { describe, expect, it } from 'vitest';
import {
  computeLineChanges,
  splitLinesForDiff,
  MAX_DIFF_LINES,
  type LineChange,
} from './lineDiff';

function lines(...v: string[]): string[] {
  return v;
}

/** テストの読みやすさ用: 'kind:start-end' の配列にする。 */
function shape(changes: LineChange[] | null): string[] | null {
  return changes && changes.map((c) => `${c.kind}:${c.startLine}-${c.endLine}`);
}

describe('splitLinesForDiff', () => {
  it('treats CRLF and LF alike', () => {
    expect(splitLinesForDiff('a\r\nb\r\nc')).toEqual(['a', 'b', 'c']);
    expect(splitLinesForDiff('a\nb\nc')).toEqual(['a', 'b', 'c']);
  });

  it('keeps the trailing empty line produced by a final newline', () => {
    expect(splitLinesForDiff('a\n')).toEqual(['a', '']);
  });
});

describe('computeLineChanges', () => {
  it('returns no changes for identical content', () => {
    expect(computeLineChanges(lines('a', 'b', 'c'), lines('a', 'b', 'c'))).toEqual([]);
  });

  // 本命の判別器: autocrlf 環境で「全行 modify」に化けないこと。
  it('reports no changes when only the line terminators differ', () => {
    const base = splitLinesForDiff('a\nb\nc\n'); // index の blob (LF)
    const cur = splitLinesForDiff('a\r\nb\r\nc\r\n'); // 作業ツリー (CRLF)
    expect(computeLineChanges(base, cur)).toEqual([]);
  });

  it('marks a single modified line', () => {
    expect(shape(computeLineChanges(lines('a', 'b', 'c'), lines('a', 'B', 'c')))).toEqual([
      'modify:2-2',
    ]);
  });

  it('marks lines added in the middle', () => {
    expect(shape(computeLineChanges(lines('a', 'd'), lines('a', 'b', 'c', 'd')))).toEqual([
      'add:2-3',
    ]);
  });

  it('marks lines added at the head', () => {
    expect(shape(computeLineChanges(lines('a'), lines('x', 'y', 'a')))).toEqual(['add:1-2']);
  });

  it('marks lines added at the tail', () => {
    expect(shape(computeLineChanges(lines('a'), lines('a', 'x', 'y')))).toEqual(['add:2-3']);
  });

  it('anchors a middle deletion on the preceding line', () => {
    // base: a b c d  /  cur: a d  → b,c が消えたので "a" (1 行目) に三角
    expect(shape(computeLineChanges(lines('a', 'b', 'c', 'd'), lines('a', 'd')))).toEqual([
      'delete:1-1',
    ]);
  });

  it('clamps a leading deletion to line 1', () => {
    expect(shape(computeLineChanges(lines('x', 'a', 'b'), lines('a', 'b')))).toEqual([
      'delete:1-1',
    ]);
  });

  it('anchors a trailing deletion on the last remaining line', () => {
    expect(shape(computeLineChanges(lines('a', 'b', 'c'), lines('a')))).toEqual(['delete:1-1']);
  });

  it('reports several independent hunks in document order', () => {
    const base = lines('a', 'b', 'c', 'd', 'e', 'f');
    const cur = lines('a', 'B', 'c', 'd', 'e', 'f', 'g');
    expect(shape(computeLineChanges(base, cur))).toEqual(['modify:2-2', 'add:7-7']);
  });

  it('separates two modifications that have matching lines between them', () => {
    const base = lines('a', 'b', 'c', 'd', 'e');
    const cur = lines('A', 'b', 'c', 'd', 'E');
    expect(shape(computeLineChanges(base, cur))).toEqual(['modify:1-1', 'modify:5-5']);
  });

  it('treats an unequal-length replacement as one modify run', () => {
    const base = lines('a', 'b', 'c', 'z');
    const cur = lines('a', 'X', 'Y', 'Z', 'W', 'z');
    expect(shape(computeLineChanges(base, cur))).toEqual(['modify:2-5']);
  });

  it('marks an entirely new file as one add run', () => {
    expect(shape(computeLineChanges([], lines('a', 'b')))).toEqual(['add:1-2']);
  });

  it('marks an emptied file as one delete anchor', () => {
    expect(shape(computeLineChanges(lines('a', 'b'), []))).toEqual(['delete:1-1']);
  });

  it('replaces the whole content as one modify run', () => {
    expect(shape(computeLineChanges(lines('a', 'b'), lines('x', 'y')))).toEqual(['modify:1-2']);
  });

  // 装飾は cur の実在行だけを指す必要がある (Monaco に範囲外の行を渡さない)。
  it('never points outside the current document', () => {
    const cases: [string[], string[]][] = [
      [lines('a', 'b', 'c'), lines('a')],
      [lines('a'), lines('a', 'b', 'c')],
      [lines('a', 'b'), []],
      [[], lines('a')],
      [lines('x', 'a', 'b'), lines('a', 'b')],
    ];
    for (const [base, cur] of cases) {
      const changes = computeLineChanges(base, cur);
      expect(changes).not.toBeNull();
      for (const c of changes!) {
        expect(c.startLine).toBeGreaterThanOrEqual(1);
        expect(c.endLine).toBeGreaterThanOrEqual(c.startLine);
        expect(c.endLine).toBeLessThanOrEqual(Math.max(1, cur.length));
      }
    }
  });

  it('bails out (null) when a side exceeds the line cap', () => {
    const huge = new Array<string>(MAX_DIFF_LINES + 1).fill('x');
    expect(computeLineChanges(huge, lines('a'))).toBeNull();
    expect(computeLineChanges(lines('a'), huge)).toBeNull();
  });

  it('bails out (null) when the edit distance is too large', () => {
    // 共通行が一切ない 5000 行 × 5000 行。トリムが効かず距離が上限を超える。
    const base = Array.from({ length: 5000 }, (_, i) => `base${i}`);
    const cur = Array.from({ length: 5000 }, (_, i) => `cur${i}`);
    expect(computeLineChanges(base, cur)).toBeNull();
  });

  // 自作の Myers を信用しないための差分テスト。素朴な LCS DP を独立に書き、
  // 「変更されていない cur 行の集合」が一致することをランダム入力で突き合わせる。
  // (Myers と LCS DP は同じ最小編集距離を達成するので、未変更行の総数は一致するはず。)
  it('agrees with a naive LCS reference on random inputs', () => {
    const alphabet = ['a', 'b', 'c', 'd'];
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const gen = (n: number) =>
      Array.from({ length: n }, () => alphabet[Math.floor(rnd() * alphabet.length)]);

    for (let trial = 0; trial < 300; trial++) {
      const base = gen(Math.floor(rnd() * 9));
      const cur = gen(Math.floor(rnd() * 9));
      const changes = computeLineChanges(base, cur);
      expect(changes).not.toBeNull();

      // 参照: LCS の長さ = 「両側に共通で残る行数」
      const dp: number[][] = Array.from({ length: base.length + 1 }, () =>
        new Array<number>(cur.length + 1).fill(0),
      );
      for (let i = 1; i <= base.length; i++) {
        for (let j = 1; j <= cur.length; j++) {
          dp[i][j] =
            base[i - 1] === cur[j - 1]
              ? dp[i - 1][j - 1] + 1
              : Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
      const lcs = dp[base.length][cur.length];

      // 実装側: add / modify が覆う cur 行数 = cur.length - (共通で残る行数)
      const covered = new Set<number>();
      for (const c of changes!) {
        if (c.kind === 'delete') continue;
        for (let l = c.startLine; l <= c.endLine; l++) covered.add(l);
      }
      expect(cur.length - covered.size).toBe(lcs);
    }
  });

  it('stays fast on a realistic large file with a local edit', () => {
    const base = Array.from({ length: 20_000 }, (_, i) => `line ${i}`);
    const cur = base.slice();
    cur[10_000] = 'changed';
    const started = Date.now();
    expect(shape(computeLineChanges(base, cur))).toEqual(['modify:10001-10001']);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
