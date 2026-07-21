import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPartialPatch, splitDiffHunks, type DiffHunk } from './diffPatch.js';
import { runGitInput } from './git.js';

/**
 * 以下の fixture 文字列は想像で書いたものではなく、scratchpad の一時 git リポジトリーで
 * 実際に `git diff` を実行して観察した実出力をそのまま書き起こしたもの(index ハッシュも
 * 実観測値)。crlf/noeof/ja の3ケースはバイト単位で実ファイルと一致することを別途
 * node スクリプトで検証済み。
 */

// 3 ハンク、LF のみ、末尾は改行あり(git diff は常に各行末に \n を出力するため)
const MULTI_DIFF = [
  'diff --git a/multi.txt b/multi.txt',
  'index 19339a3..e91df7f 100644',
  '--- a/multi.txt',
  '+++ b/multi.txt',
  '@@ -1,5 +1,5 @@',
  ' line1',
  '-line2',
  '+line2-MODIFIED',
  ' line3',
  ' line4',
  ' line5',
  '@@ -12,6 +12,7 @@ line11',
  ' line12',
  ' line13',
  ' line14',
  '+INSERTED-MIDDLE',
  ' line15',
  ' line16',
  ' line17',
  '@@ -27,4 +28,4 @@ line26',
  ' line27',
  ' line28',
  ' line29',
  '-line30',
  '+line30-MODIFIED',
  '',
].join('\n');

// CRLF ファイルの diff。内容行(' '/'+'/'-' 始まり)だけが末尾に \r を持ち、
// diff/index/---/+++/@@ のメタ行は \r を持たない(git 自身が生成する行のため)。
const CRLF_DIFF = [
  'diff --git a/crlf.txt b/crlf.txt',
  'index acaab67..9a8c2ab 100644',
  '--- a/crlf.txt',
  '+++ b/crlf.txt',
  '@@ -1,10 +1,10 @@',
  ' crlf1\r',
  '-crlf2\r',
  '+crlf2-MOD\r',
  ' crlf3\r',
  ' crlf4\r',
  ' crlf5\r',
  ' crlf6\r',
  ' crlf7\r',
  '-crlf8\r',
  '+crlf8-MOD\r',
  ' crlf9\r',
  ' crlf10\r',
  '',
].join('\n');

// 旧側・新側の両方に「末尾に改行なし」のファイルを変更した diff。
// git diff の出力自体は marker 行の後にも \n を付けて出す(観測済み)。
const NOEOF_DIFF = [
  'diff --git a/noeof.txt b/noeof.txt',
  'index 1c943a9..75adfc2 100644',
  '--- a/noeof.txt',
  '+++ b/noeof.txt',
  '@@ -1,3 +1,3 @@',
  ' a',
  ' b',
  '-c',
  '\\ No newline at end of file',
  '+c-CHANGED',
  '\\ No newline at end of file',
  '',
].join('\n');

// 日本語(非 ASCII マルチバイト)を含む diff。UTF-8 の生テキストとして保持し、
// テスト内で Buffer 経由で「呼び出し側が渡す latin1 文字列」に変換して使う。
const JA_DIFF_UTF8 = [
  'diff --git a/ja.txt b/ja.txt',
  'index 24b86ed..a2237a8 100644',
  '--- a/ja.txt',
  '+++ b/ja.txt',
  '@@ -1,3 +1,3 @@',
  ' 日本語1行目',
  '-日本語2行目',
  '+日本語2行目-変更',
  ' 日本語3行目',
  '',
].join('\n');

/** header + hunks を再結合した完全なテキスト(全ハンク選択の build と同義)。 */
function reassemble(header: string, hunks: DiffHunk[]): string {
  const parts: string[] = [];
  if (header !== '') parts.push(header);
  for (const hunk of hunks) parts.push([hunk.header, ...hunk.lines].join('\n'));
  return parts.join('\n');
}

describe('splitDiffHunks', () => {
  it('splits a multi-hunk LF diff into a file header and 3 self-contained hunks', () => {
    const { header, hunks } = splitDiffHunks(MULTI_DIFF);
    expect(header).toBe(
      ['diff --git a/multi.txt b/multi.txt', 'index 19339a3..e91df7f 100644', '--- a/multi.txt', '+++ b/multi.txt'].join(
        '\n',
      ),
    );
    expect(hunks).toHaveLength(3);
    expect(hunks[0].header).toBe('@@ -1,5 +1,5 @@');
    expect(hunks[0].lines).toEqual([' line1', '-line2', '+line2-MODIFIED', ' line3', ' line4', ' line5']);
    expect(hunks[1].header).toBe('@@ -12,6 +12,7 @@ line11');
    expect(hunks[1].lines).toEqual([' line12', ' line13', ' line14', '+INSERTED-MIDDLE', ' line15', ' line16', ' line17']);
    expect(hunks[2].header).toBe('@@ -27,4 +28,4 @@ line26');
    // 最後のハンクの最後の要素は元テキストの末尾改行を表す空文字列
    expect(hunks[2].lines).toEqual([' line27', ' line28', ' line29', '-line30', '+line30-MODIFIED', '']);
  });

  it('keeps the trailing \\r of CRLF content lines while leaving diff meta lines untouched', () => {
    const { header, hunks } = splitDiffHunks(CRLF_DIFF);
    expect(header.endsWith('\r')).toBe(false);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].header).toBe('@@ -1,10 +1,10 @@');
    expect(hunks[0].lines[0]).toBe(' crlf1\r');
    expect(hunks[0].lines).toContain('-crlf2\r');
    expect(hunks[0].lines).toContain('+crlf2-MOD\r');
    // すべての内容行が \r で終わっている(末尾の空要素を除く)
    for (const line of hunks[0].lines.slice(0, -1)) {
      expect(line.endsWith('\r')).toBe(true);
    }
  });

  it('attributes both the old-side and new-side "no newline at end of file" markers to their hunk', () => {
    const { hunks } = splitDiffHunks(NOEOF_DIFF);
    expect(hunks).toHaveLength(1);
    const lines = hunks[0].lines;
    // 旧側 "-c" の直後に marker、新側 "+c-CHANGED" の直後にも marker
    expect(lines[lines.indexOf('-c') + 1]).toBe('\\ No newline at end of file');
    expect(lines[lines.indexOf('+c-CHANGED') + 1]).toBe('\\ No newline at end of file');
  });
});

describe('buildPartialPatch', () => {
  it('reassembles the exact original text when all hunks are selected (round trip)', () => {
    for (const diff of [MULTI_DIFF, CRLF_DIFF, NOEOF_DIFF, JA_DIFF_UTF8]) {
      const { header, hunks } = splitDiffHunks(diff);
      const rebuilt = buildPartialPatch(header, hunks, hunks.map((_, i) => i));
      expect(rebuilt).toBe(diff);
      // reassemble() は buildPartialPatch と独立に書いた再結合ロジック — 二重チェック
      expect(reassemble(header, hunks)).toBe(diff);
    }
  });

  it('includes only the first hunk when selecting index 0 from a 3-hunk diff, still newline-terminated', () => {
    const { header, hunks } = splitDiffHunks(MULTI_DIFF);
    const patch = buildPartialPatch(header, hunks, [0]);
    // hunk 0 is not the file's last hunk, so its trailing line originally relied on the next
    // hunk's "@@" header to supply its terminating \n. Dropping that hunk must not leave the
    // patch's last line unterminated, or `git apply` rejects it ("corrupt patch").
    expect(patch.endsWith('\n')).toBe(true);
    expect(patch).toBe(
      [
        'diff --git a/multi.txt b/multi.txt',
        'index 19339a3..e91df7f 100644',
        '--- a/multi.txt',
        '+++ b/multi.txt',
        '@@ -1,5 +1,5 @@',
        ' line1',
        '-line2',
        '+line2-MODIFIED',
        ' line3',
        ' line4',
        ' line5',
        '',
      ].join('\n'),
    );
  });

  it('includes only the last hunk (and its trailing-newline marker) when selecting the final index', () => {
    const { header, hunks } = splitDiffHunks(MULTI_DIFF);
    const patch = buildPartialPatch(header, hunks, [2]);
    expect(patch).toBe(
      [
        'diff --git a/multi.txt b/multi.txt',
        'index 19339a3..e91df7f 100644',
        '--- a/multi.txt',
        '+++ b/multi.txt',
        '@@ -27,4 +28,4 @@ line26',
        ' line27',
        ' line28',
        ' line29',
        '-line30',
        '+line30-MODIFIED',
        '',
      ].join('\n'),
    );
  });

  it('includes only the selected non-contiguous hunks (0 and 2), skipping hunk 1, in order', () => {
    const { header, hunks } = splitDiffHunks(MULTI_DIFF);
    const patch = buildPartialPatch(header, hunks, [0, 2]);
    expect(patch).not.toContain('INSERTED-MIDDLE');
    expect(patch).toContain('line2-MODIFIED');
    expect(patch).toContain('line30-MODIFIED');
    expect(patch).toBe(
      [
        'diff --git a/multi.txt b/multi.txt',
        'index 19339a3..e91df7f 100644',
        '--- a/multi.txt',
        '+++ b/multi.txt',
        '@@ -1,5 +1,5 @@',
        ' line1',
        '-line2',
        '+line2-MODIFIED',
        ' line3',
        ' line4',
        ' line5',
        '@@ -27,4 +28,4 @@ line26',
        ' line27',
        ' line28',
        ' line29',
        '-line30',
        '+line30-MODIFIED',
        '',
      ].join('\n'),
    );
  });

  it('throws when no hunks are selected', () => {
    const { header, hunks } = splitDiffHunks(MULTI_DIFF);
    expect(() => buildPartialPatch(header, hunks, [])).toThrow();
  });

  it('throws on an out-of-range hunk index', () => {
    const { header, hunks } = splitDiffHunks(MULTI_DIFF);
    expect(() => buildPartialPatch(header, hunks, [99])).toThrow();
  });
});

describe('non-ASCII byte preservation (latin1 pass-through)', () => {
  it('round-trips multibyte UTF-8 content carried as a latin1 string without corruption', () => {
    // 呼び出し側の実運用と同じ変換: Buffer(UTF-8) -> latin1 文字列
    const latin1 = Buffer.from(JA_DIFF_UTF8, 'utf8').toString('latin1');
    const { header, hunks } = splitDiffHunks(latin1);
    const rebuiltLatin1 = buildPartialPatch(header, hunks, [0]);
    // latin1 -> Buffer -> utf8 で元の日本語テキストに戻ることを確認(バイトが素通りした証拠)
    const rebuiltUtf8 = Buffer.from(rebuiltLatin1, 'latin1').toString('utf8');
    expect(rebuiltUtf8).toBe(JA_DIFF_UTF8);
  });

  it('does not merge or reorder bytes when only the single non-ASCII hunk is selected', () => {
    const latin1 = Buffer.from(JA_DIFF_UTF8, 'utf8').toString('latin1');
    const { hunks } = splitDiffHunks(latin1);
    expect(hunks).toHaveLength(1);
    // latin1 化された行はそのままバイト数を保つ(日本語1行目 は UTF-8 で 15 バイト)
    const line = hunks[0].lines[0];
    expect(Buffer.from(line, 'latin1').toString('utf8')).toBe(' 日本語1行目');
  });
});

describe('integration: real git apply --cached --check', () => {
  /**
   * fixture 文字列との比較だけでは「git 自身がパッチとして受理するか」までは検証できない
   * (実際、非最終ハンク選択時に末尾改行が欠落して "corrupt patch" になるバグはこの
   * テストでのみ検出できた)。一時リポジトリーで実際に diff を生成し、部分パッチを
   * `git apply --cached --check` に通すところまで確認する。
   */
  it('accepts a partial patch selecting a non-final hunk (regression: missing trailing newline)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diffpatch-it-'));
    try {
      const run = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
      run(['init', '-q']);
      run(['config', 'user.email', 'test@test.com']);
      run(['config', 'user.name', 'test']);
      run(['config', 'core.autocrlf', 'false']);

      const baseLines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
      fs.writeFileSync(path.join(dir, 'multi.txt'), baseLines.join('\n') + '\n');
      run(['add', '-A']);
      run(['commit', '-q', '-m', 'base']);

      const modifiedLines = [...baseLines];
      modifiedLines[1] = 'line2-MOD'; // near the top
      modifiedLines[modifiedLines.length - 1] += '-MOD'; // near the bottom -> separate hunk
      fs.writeFileSync(path.join(dir, 'multi.txt'), modifiedLines.join('\n') + '\n');

      const diffBuf = execFileSync('git', ['-c', 'core.quotepath=false', 'diff', '--', 'multi.txt'], {
        cwd: dir,
        encoding: 'buffer',
        maxBuffer: 64 * 1024 * 1024,
      });
      const diffLatin1 = diffBuf.toString('latin1');
      const { header, hunks } = splitDiffHunks(diffLatin1);
      expect(hunks.length).toBeGreaterThanOrEqual(2);

      // 先頭ハンク(＝このファイルの最終ハンクではない)だけを選んで組み立てる。
      const partial = buildPartialPatch(header, hunks, [0]);
      const checkResult = await runGitInput(dir, ['apply', '--cached', '--check', '-'], Buffer.from(partial, 'latin1'));
      expect(checkResult.toString('utf8')).toBe('');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
