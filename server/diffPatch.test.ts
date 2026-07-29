import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import iconv from 'iconv-lite';
import {
  buildPartialPatch,
  buildPartialPatchLines,
  checkApplyHunksRequest,
  HUNK_CONFLICT_MESSAGE,
  hashHunk,
  splitDiffHunks,
  type DiffHunk,
} from './diffPatch.js';
import { runGitInput } from './git.js';

// vitest はリポジトリールートから走るため process.cwd() はリポジトリールートになる。
// ドライブ直下(C:\vt5 等)は後片付けがツール保護に弾かれるため使わず、./vt 配下を使う。
const TMP_ROOT = path.join(process.cwd(), 'vt');

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
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'diffpatch-it-'));
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

/**
 * 以下 buildPartialPatchLines のテスト群。行単位選択では未選択行の扱いが適用方向
 * (forward/reverse) で逆転し、`@@` 行数の再計算も必要になる(buildPartialPatch のような
 * ハンク自己完結の前提が崩れるため)。この逆転規則と再計算式は scratchpad の一時
 * リポジトリーで実 git を使って実測・確認済み(タスクブリーフ記載の対応表を裏取り)。
 * fixture 文字列を手書きすると転記ミスのリスクがあるため、ここでは実 git で都度
 * diff を生成し、生成したパッチも `git apply --check` および実適用で検証する。
 */

describe('buildPartialPatchLines: regression (byte-identical to buildPartialPatch when fully selected)', () => {
  it('matches buildPartialPatch byte-for-byte when lineSelections is omitted', () => {
    for (const diff of [MULTI_DIFF, CRLF_DIFF, NOEOF_DIFF, JA_DIFF_UTF8]) {
      const { header, hunks } = splitDiffHunks(diff);
      for (const selected of [hunks.map((_, i) => i), [0], [hunks.length - 1]]) {
        const expected = buildPartialPatch(header, hunks, selected);
        expect(buildPartialPatchLines(header, hunks, selected, undefined, 'forward')).toBe(expected);
        expect(buildPartialPatchLines(header, hunks, selected, undefined, 'reverse')).toBe(expected);
      }
    }
  });

  it('matches buildPartialPatch byte-for-byte when every lineSelections entry is null', () => {
    const { header, hunks } = splitDiffHunks(MULTI_DIFF);
    const selected = [0, 2];
    const expected = buildPartialPatch(header, hunks, selected);
    expect(buildPartialPatchLines(header, hunks, selected, [null, null], 'forward')).toBe(expected);
  });
});

describe('buildPartialPatchLines: invalid input', () => {
  it('throws on an out-of-range line index', () => {
    const { header, hunks } = splitDiffHunks(MULTI_DIFF);
    expect(() => buildPartialPatchLines(header, hunks, [0], [[999]], 'forward')).toThrow();
  });

  it('throws on a negative line index', () => {
    const { header, hunks } = splitDiffHunks(MULTI_DIFF);
    expect(() => buildPartialPatchLines(header, hunks, [0], [[-1]], 'forward')).toThrow();
  });

  it('throws on a non-integer line index', () => {
    const { header, hunks } = splitDiffHunks(MULTI_DIFF);
    expect(() => buildPartialPatchLines(header, hunks, [0], [[1.5]], 'forward')).toThrow();
  });

  it('throws when a hunk line-selection array is empty', () => {
    const { header, hunks } = splitDiffHunks(MULTI_DIFF);
    expect(() => buildPartialPatchLines(header, hunks, [0], [[]], 'forward')).toThrow();
  });

  it('throws when lineSelections length does not match selected length', () => {
    const { header, hunks } = splitDiffHunks(MULTI_DIFF);
    expect(() => buildPartialPatchLines(header, hunks, [0, 1], [[1, 2]], 'forward')).toThrow();
  });

  it('throws when a selection leaves no "+"/"-" line in the resulting hunk (context-only selection)', () => {
    const { header, hunks } = splitDiffHunks(MULTI_DIFF);
    // hunk 0's lines: [' line1', '-line2', '+line2-MODIFIED', ' line3', ' line4', ' line5']
    // selecting only the context-line index (0) leaves the change lines unselected; forward mode
    // converts the '-' to context and drops the '+', so nothing but context remains.
    expect(() => buildPartialPatchLines(header, hunks, [0], [[0]], 'forward')).toThrow();
  });

  it('still throws on an out-of-range hunk index (existing buildPartialPatch guard, unchanged)', () => {
    const { header, hunks } = splitDiffHunks(MULTI_DIFF);
    expect(() => buildPartialPatchLines(header, hunks, [99], undefined, 'forward')).toThrow();
  });
});

/** 一時 git リポジトリーを作り、コマンド実行ヘルパーを返す(既存の integration テストと同じ流儀)。 */
function makeRepo(): { dir: string; run: (args: string[]) => string } {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'diffpatch-lines-it-'));
  const run = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  run(['init', '-q']);
  run(['config', 'user.email', 'test@test.com']);
  run(['config', 'user.name', 'test']);
  run(['config', 'core.autocrlf', 'false']);
  return { dir, run };
}

/** git apply へ渡すバイト列を一切変換しない latin1 デコードで diff を取得する(適用側と同じ経路)。 */
function diffLatin1(dir: string, args: string[]): string {
  const buf = execFileSync('git', args, { cwd: dir, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  return buf.toString('latin1');
}

/** git show :<path> でステージ済み blob をバイトのまま読む。 */
function readStagedBlob(dir: string, relPath: string): Buffer {
  return execFileSync('git', ['show', `:${relPath}`], { cwd: dir, encoding: 'buffer' });
}

// 一時リポジトリーの起動・複数 git 呼び出し・patch apply が Windows の subprocess spawn
// オーバーヘッドで既定の 5000ms を超えることがあるため、実 git を伴うテストは個別に延長する。
const GIT_IT_TIMEOUT = 20_000;

describe('buildPartialPatchLines: real git — forward (stage)', () => {
  it(
    'stages only the selected lines within a hunk, converting the unselected "-" to context and dropping the unselected "+"',
    async () => {
      const { dir, run } = makeRepo();
      try {
        const base = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
        fs.writeFileSync(path.join(dir, 'f.txt'), base);
        run(['add', '-A']);
        run(['commit', '-q', '-m', 'base']);

        const bothModified = base.replace('line2\n', 'line2-MOD\n').replace('line4\n', 'line4-MOD\n');
        fs.writeFileSync(path.join(dir, 'f.txt'), bothModified);

        const diffText = diffLatin1(dir, ['diff', '--', 'f.txt']);
        const { header, hunks } = splitDiffHunks(diffText);
        expect(hunks).toHaveLength(1); // default context=3 merges both changes into one hunk
        const minusIdx = hunks[0].lines.indexOf('-line2');
        const plusIdx = hunks[0].lines.indexOf('+line2-MOD');
        expect(minusIdx).toBeGreaterThanOrEqual(0);
        expect(plusIdx).toBeGreaterThanOrEqual(0);

        const patch = buildPartialPatchLines(header, hunks, [0], [[minusIdx, plusIdx]], 'forward');
        const check = await runGitInput(dir, ['apply', '--cached', '--check', '-'], Buffer.from(patch, 'latin1'));
        expect(check.toString('utf8')).toBe('');
        await runGitInput(dir, ['apply', '--cached', '-'], Buffer.from(patch, 'latin1'));

        expect(run(['status', '--short']).trim()).toBe('MM f.txt');
        // ステージ内容はバイト単位で「line2 だけ変更・line4 は未変更」と厳密一致すること
        // (diff テキストの部分文字列一致ではなく、実ファイル内容そのものを比較する)。
        const expectedStaged = base.replace('line2\n', 'line2-MOD\n');
        expect(readStagedBlob(dir, 'f.txt').toString('utf8')).toBe(expectedStaged);
        // worktree は一切触られておらず、非選択行(line4 の変更)も含め両方の編集が残っていること。
        expect(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8')).toBe(bothModified);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    GIT_IT_TIMEOUT,
  );

  it(
    'recomputes @@ line counts across two hunks in the same patch (cumulative newStart offset)',
    async () => {
      const { dir, run } = makeRepo();
      try {
        const base = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
        fs.writeFileSync(path.join(dir, 'f.txt'), base);
        run(['add', '-A']);
        run(['commit', '-q', '-m', 'base']);

        // hunk1: a paired change (line3) + a pure insertion (dropped later, shifting new-side counts).
        // hunk2: an unrelated paired change far enough away to stay a separate hunk.
        const modified = base.replace('line3\n', 'line3-MOD\nNEW-INS\n').replace('line25\n', 'line25-MOD\n');
        fs.writeFileSync(path.join(dir, 'f.txt'), modified);

        const diffText = diffLatin1(dir, ['diff', '--', 'f.txt']);
        const { header, hunks } = splitDiffHunks(diffText);
        expect(hunks).toHaveLength(2);

        const minusIdx = hunks[0].lines.indexOf('-line3');
        const plusIdx = hunks[0].lines.indexOf('+line3-MOD');
        expect(hunks[0].lines).toContain('+NEW-INS'); // the pure insertion we intend to drop

        // select the line3 pair in hunk 0 (dropping the NEW-INS insertion), and the whole hunk 1.
        const patch = buildPartialPatchLines(header, hunks, [0, 1], [[minusIdx, plusIdx], null], 'forward');
        const check = await runGitInput(dir, ['apply', '--cached', '--check', '-'], Buffer.from(patch, 'latin1'));
        expect(check.toString('utf8')).toBe('');
        await runGitInput(dir, ['apply', '--cached', '-'], Buffer.from(patch, 'latin1'));

        // staged: line3 と line25 の変更のみ、NEW-INS は含まれない
        const expectedStaged = base.replace('line3\n', 'line3-MOD\n').replace('line25\n', 'line25-MOD\n');
        expect(readStagedBlob(dir, 'f.txt').toString('utf8')).toBe(expectedStaged);
        // worktree は変更後の内容のまま(NEW-INS はここにだけ残る)
        expect(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8')).toBe(modified);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    GIT_IT_TIMEOUT,
  );
});

describe('buildPartialPatchLines: real git — reverse (unstage / discard)', () => {
  it(
    'unstages only the selected lines, converting the unselected "+" to context and dropping the unselected "-"',
    async () => {
      const { dir, run } = makeRepo();
      try {
        const base = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
        fs.writeFileSync(path.join(dir, 'f.txt'), base);
        run(['add', '-A']);
        run(['commit', '-q', '-m', 'base']);

        const bothModified = base.replace('line2\n', 'line2-MOD\n').replace('line4\n', 'line4-MOD\n');
        fs.writeFileSync(path.join(dir, 'f.txt'), bothModified);
        run(['add', '-A']); // fully staged: both changes

        const diffText = diffLatin1(dir, ['diff', '--cached', '--', 'f.txt']);
        const { header, hunks } = splitDiffHunks(diffText);
        expect(hunks).toHaveLength(1);
        const minusIdx = hunks[0].lines.indexOf('-line2');
        const plusIdx = hunks[0].lines.indexOf('+line2-MOD');

        const patch = buildPartialPatchLines(header, hunks, [0], [[minusIdx, plusIdx]], 'reverse');
        const check = await runGitInput(dir, ['apply', '--cached', '--reverse', '--check', '-'], Buffer.from(patch, 'latin1'));
        expect(check.toString('utf8')).toBe('');
        await runGitInput(dir, ['apply', '--cached', '--reverse', '-'], Buffer.from(patch, 'latin1'));

        expect(run(['status', '--short']).trim()).toBe('MM f.txt');
        // unstage された line2 は HEAD の元の値に戻り、line4 の変更は staged のまま残ること
        const expectedStaged = base.replace('line4\n', 'line4-MOD\n');
        expect(readStagedBlob(dir, 'f.txt').toString('utf8')).toBe(expectedStaged);
        // worktree は一切触られておらず両方の編集が残っていること(unstage は index のみ操作)
        expect(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8')).toBe(bothModified);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    GIT_IT_TIMEOUT,
  );

  it(
    'discards only the selected lines from the worktree via plain --reverse (no --cached), preserving the rest',
    async () => {
      const { dir, run } = makeRepo();
      try {
        const base = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
        fs.writeFileSync(path.join(dir, 'f.txt'), base);
        run(['add', '-A']);
        run(['commit', '-q', '-m', 'base']);

        const bothModified = base.replace('line2\n', 'line2-MOD\n').replace('line4\n', 'line4-MOD\n');
        fs.writeFileSync(path.join(dir, 'f.txt'), bothModified);
        // deliberately NOT staged: scope='discard' reverses the worktree diff directly

        const diffText = diffLatin1(dir, ['diff', '--', 'f.txt']);
        const { header, hunks } = splitDiffHunks(diffText);
        const minusIdx = hunks[0].lines.indexOf('-line2');
        const plusIdx = hunks[0].lines.indexOf('+line2-MOD');

        // discard the line2 change, keep the line4 change in the worktree
        const patch = buildPartialPatchLines(header, hunks, [0], [[minusIdx, plusIdx]], 'reverse');
        const check = await runGitInput(dir, ['apply', '--reverse', '--check', '-'], Buffer.from(patch, 'latin1'));
        expect(check.toString('utf8')).toBe('');
        await runGitInput(dir, ['apply', '--reverse', '-'], Buffer.from(patch, 'latin1'));

        // trim() で先頭スペース(index 列が空)も落ちるため 'M f.txt' (worktree のみ M) になる
        expect(run(['status', '--short']).trim()).toBe('M f.txt');
        // line2 は元に戻り、line4 の変更(非選択)は失われずそのまま残ること
        const expectedWorktree = base.replace('line4\n', 'line4-MOD\n');
        expect(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8')).toBe(expectedWorktree);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    GIT_IT_TIMEOUT,
  );
});

describe('buildPartialPatchLines: encodings and no-newline-at-eof (real git)', () => {
  it(
    'preserves CRLF bytes exactly when staging only one of two CRLF-line changes',
    async () => {
      const { dir, run } = makeRepo();
      try {
        const base = Array.from({ length: 8 }, (_, i) => `line${i + 1}`).join('\r\n') + '\r\n';
        fs.writeFileSync(path.join(dir, 'crlf.txt'), base);
        run(['add', '-A']);
        run(['commit', '-q', '-m', 'base']);

        const bothModified = base.replace('line2\r\n', 'line2-MOD\r\n').replace('line4\r\n', 'line4-MOD\r\n');
        fs.writeFileSync(path.join(dir, 'crlf.txt'), bothModified);

        const diffText = diffLatin1(dir, ['diff', '--', 'crlf.txt']);
        const { header, hunks } = splitDiffHunks(diffText);
        expect(hunks).toHaveLength(1);
        expect(hunks[0].lines).toContain('-line2\r');
        const minusIdx = hunks[0].lines.indexOf('-line2\r');
        const plusIdx = hunks[0].lines.indexOf('+line2-MOD\r');

        const patch = buildPartialPatchLines(header, hunks, [0], [[minusIdx, plusIdx]], 'forward');
        // the converted context line must keep its trailing \r (byte-exact, no CRLF normalization)
        expect(patch).toContain(' line4\r');
        const check = await runGitInput(dir, ['apply', '--cached', '--check', '-'], Buffer.from(patch, 'latin1'));
        expect(check.toString('utf8')).toBe('');
        await runGitInput(dir, ['apply', '--cached', '-'], Buffer.from(patch, 'latin1'));

        const expectedStaged = base.replace('line2\r\n', 'line2-MOD\r\n');
        const stagedBlob = readStagedBlob(dir, 'crlf.txt');
        expect(stagedBlob.includes(0x0d)).toBe(true); // \r bytes preserved
        expect(stagedBlob.toString('latin1')).toBe(expectedStaged);
        expect(stagedBlob.toString('utf8')).not.toContain('�');
        expect(fs.readFileSync(path.join(dir, 'crlf.txt'), 'latin1')).toBe(bothModified); // worktree untouched
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    GIT_IT_TIMEOUT,
  );

  it(
    'preserves Shift_JIS byte sequences exactly when staging only one of two changed lines',
    async () => {
      const { dir, run } = makeRepo();
      try {
        const baseText = ['一行目', '二行目', '三行目', '四行目', '五行目', '六行目', '七行目'].join('\n') + '\n';
        fs.writeFileSync(path.join(dir, 'sjis.txt'), iconv.encode(baseText, 'shift_jis'));
        run(['add', '-A']);
        run(['commit', '-q', '-m', 'base']);

        const modifiedText = baseText.replace('二行目\n', '二行目-変更\n').replace('四行目\n', '四行目-変更\n');
        fs.writeFileSync(path.join(dir, 'sjis.txt'), iconv.encode(modifiedText, 'shift_jis'));

        const diffText = diffLatin1(dir, ['diff', '--', 'sjis.txt']);
        const { header, hunks } = splitDiffHunks(diffText);
        expect(hunks).toHaveLength(1);
        const minusLine = iconv.encode('二行目', 'shift_jis').toString('latin1');
        const plusLine = iconv.encode('二行目-変更', 'shift_jis').toString('latin1');
        const minusIdx = hunks[0].lines.indexOf('-' + minusLine);
        const plusIdx = hunks[0].lines.indexOf('+' + plusLine);
        expect(minusIdx).toBeGreaterThanOrEqual(0);
        expect(plusIdx).toBeGreaterThanOrEqual(0);

        const patch = buildPartialPatchLines(header, hunks, [0], [[minusIdx, plusIdx]], 'forward');
        const check = await runGitInput(dir, ['apply', '--cached', '--check', '-'], Buffer.from(patch, 'latin1'));
        expect(check.toString('utf8')).toBe('');
        await runGitInput(dir, ['apply', '--cached', '-'], Buffer.from(patch, 'latin1'));

        const expectedStagedText = baseText.replace('二行目\n', '二行目-変更\n'); // 四行目 は非選択のまま残る
        const stagedBlob = readStagedBlob(dir, 'sjis.txt');
        expect(iconv.decode(stagedBlob, 'shift_jis')).toBe(expectedStagedText);
        expect(iconv.decode(stagedBlob, 'shift_jis')).not.toContain('�');
        const worktreeBlob = fs.readFileSync(path.join(dir, 'sjis.txt'));
        expect(iconv.decode(worktreeBlob, 'shift_jis')).toBe(modifiedText); // worktree untouched
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    GIT_IT_TIMEOUT,
  );

  it(
    'keeps the "no newline at end of file" marker attached when the eof-affecting change is deselected (forward/stage)',
    async () => {
      const { dir, run } = makeRepo();
      try {
        fs.writeFileSync(path.join(dir, 'noeof.txt'), 'a\nb\nc\nlast');
        run(['add', '-A']);
        run(['commit', '-q', '-m', 'base']);

        fs.writeFileSync(path.join(dir, 'noeof.txt'), 'a\nb-MOD\nc\nlast-MOD');

        const diffText = diffLatin1(dir, ['diff', '--', 'noeof.txt']);
        const { header, hunks } = splitDiffHunks(diffText);
        expect(hunks).toHaveLength(1);
        expect(hunks[0].lines).toContain('\\ No newline at end of file');
        const minusIdx = hunks[0].lines.indexOf('-b');
        const plusIdx = hunks[0].lines.indexOf('+b-MOD');

        // select only the earlier "b" change; leave the trailing eof-affecting "last" change deselected
        const patch = buildPartialPatchLines(header, hunks, [0], [[minusIdx, plusIdx]], 'forward');
        const check = await runGitInput(dir, ['apply', '--cached', '--check', '-'], Buffer.from(patch, 'latin1'));
        expect(check.toString('utf8')).toBe('');
        await runGitInput(dir, ['apply', '--cached', '-'], Buffer.from(patch, 'latin1'));

        const stagedBlob = readStagedBlob(dir, 'noeof.txt');
        expect(stagedBlob.toString('utf8')).toBe('a\nb-MOD\nc\nlast'); // exact bytes, no trailing \n added
        const worktree = fs.readFileSync(path.join(dir, 'noeof.txt'), 'utf8');
        expect(worktree).toBe('a\nb-MOD\nc\nlast-MOD'); // worktree untouched by staging
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    GIT_IT_TIMEOUT,
  );

  it(
    'keeps the "no newline at end of file" marker attached when the eof-affecting change is deselected (reverse/unstage)',
    async () => {
      const { dir, run } = makeRepo();
      try {
        fs.writeFileSync(path.join(dir, 'noeof.txt'), 'a\nb\nc\nlast');
        run(['add', '-A']);
        run(['commit', '-q', '-m', 'base']);

        fs.writeFileSync(path.join(dir, 'noeof.txt'), 'a\nb-MOD\nc\nlast-MOD');
        run(['add', '-A']); // fully staged

        const diffText = diffLatin1(dir, ['diff', '--cached', '--', 'noeof.txt']);
        const { header, hunks } = splitDiffHunks(diffText);
        const minusIdx = hunks[0].lines.indexOf('-b');
        const plusIdx = hunks[0].lines.indexOf('+b-MOD');

        // unstage only the "b" change; leave the eof-affecting "last" change staged
        const patch = buildPartialPatchLines(header, hunks, [0], [[minusIdx, plusIdx]], 'reverse');
        const check = await runGitInput(dir, ['apply', '--cached', '--reverse', '--check', '-'], Buffer.from(patch, 'latin1'));
        expect(check.toString('utf8')).toBe('');
        await runGitInput(dir, ['apply', '--cached', '--reverse', '-'], Buffer.from(patch, 'latin1'));

        const stagedBlob = readStagedBlob(dir, 'noeof.txt');
        expect(stagedBlob.toString('utf8')).toBe('a\nb\nc\nlast-MOD'); // "b" unstaged, "last-MOD" stays staged
        const worktree = fs.readFileSync(path.join(dir, 'noeof.txt'), 'utf8');
        expect(worktree).toBe('a\nb-MOD\nc\nlast-MOD'); // worktree untouched by unstage
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    GIT_IT_TIMEOUT,
  );
});

/**
 * 不具合 1 の回帰テスト群: 1 つの変更ブロック内(削除行の連続 → 追加行の連続、という
 * 単一の連続範囲)に **2 つ以上の行変更が隣接** し、その一部だけを選択したときの並び順を
 * 検証する。既存テスト(上の describe 群)は選択した変更が互いに離れている
 * (context 3 行以上を挟む、既定の diff context 幅でも別々の変更として現れる)ため、
 * このバグを 1 件も検出できていなかった(builder ブリーフに明記された前任の教訓)。
 *
 * 各テストは共通して:
 * - `git apply --check` の成功や `status --short` の記号だけでは合格としない
 * - 適用後の実ファイル内容(`git show :path` / `fs.readFileSync`)を、期待される
 *   post-image の文字列と **完全一致** で比較する(順序が入れ替わっていれば必ず落ちる)
 */
describe('buildPartialPatchLines: regression — adjacent multi-line change block, partial selection', () => {
  it(
    'forward/stage: selecting only the FIRST pair of an adjacent 2-line replace keeps post-image order correct',
    async () => {
      const { dir, run } = makeRepo();
      try {
        const base = ['line1', 'line2', 'line3', 'line4'].join('\n') + '\n';
        fs.writeFileSync(path.join(dir, 'f.txt'), base);
        run(['add', '-A']);
        run(['commit', '-q', '-m', 'base']);

        // line2/line3 は隣接しているため diff は 1 つの変更ブロックにまとまる
        // (-line2,-line3,+line2-CHANGED,+line3-CHANGED という並び。実 git で確認済み)。
        const modified = ['line1', 'line2-CHANGED', 'line3-CHANGED', 'line4'].join('\n') + '\n';
        fs.writeFileSync(path.join(dir, 'f.txt'), modified);

        const diffText = diffLatin1(dir, ['diff', '--', 'f.txt']);
        const { header, hunks } = splitDiffHunks(diffText);
        expect(hunks).toHaveLength(1);
        expect(hunks[0].lines).toEqual([
          ' line1',
          '-line2',
          '-line3',
          '+line2-CHANGED',
          '+line3-CHANGED',
          ' line4',
          '', // 末尾改行の番人(diff テキストが '\n' 終端のため)
        ]);
        const minusIdx = hunks[0].lines.indexOf('-line2');
        const plusIdx = hunks[0].lines.indexOf('+line2-CHANGED');

        const patch = buildPartialPatchLines(header, hunks, [0], [[minusIdx, plusIdx]], 'forward');
        const check = await runGitInput(dir, ['apply', '--cached', '--check', '-'], Buffer.from(patch, 'latin1'));
        expect(check.toString('utf8')).toBe(''); // apply 成功は合格の根拠にしない(ここでは前提確認のみ)
        await runGitInput(dir, ['apply', '--cached', '-'], Buffer.from(patch, 'latin1'));

        // 意図した post-image: line1, line2-CHANGED, line3, line4 の順(バグ再現時は
        // line1, line3, line2-CHANGED, line4 という壊れた順序になっていた)。
        const expectedStaged = ['line1', 'line2-CHANGED', 'line3', 'line4'].join('\n') + '\n';
        expect(readStagedBlob(dir, 'f.txt').toString('utf8')).toBe(expectedStaged);
        expect(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8')).toBe(modified); // worktree は無変更
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    GIT_IT_TIMEOUT,
  );

  it(
    'forward/stage: selecting only the SECOND (later) pair of the same block also keeps order correct',
    async () => {
      const { dir, run } = makeRepo();
      try {
        const base = ['line1', 'line2', 'line3', 'line4'].join('\n') + '\n';
        fs.writeFileSync(path.join(dir, 'f.txt'), base);
        run(['add', '-A']);
        run(['commit', '-q', '-m', 'base']);

        const modified = ['line1', 'line2-CHANGED', 'line3-CHANGED', 'line4'].join('\n') + '\n';
        fs.writeFileSync(path.join(dir, 'f.txt'), modified);

        const diffText = diffLatin1(dir, ['diff', '--', 'f.txt']);
        const { header, hunks } = splitDiffHunks(diffText);
        const minusIdx = hunks[0].lines.indexOf('-line3');
        const plusIdx = hunks[0].lines.indexOf('+line3-CHANGED');

        const patch = buildPartialPatchLines(header, hunks, [0], [[minusIdx, plusIdx]], 'forward');
        await runGitInput(dir, ['apply', '--cached', '-'], Buffer.from(patch, 'latin1'));

        const expectedStaged = ['line1', 'line2', 'line3-CHANGED', 'line4'].join('\n') + '\n';
        expect(readStagedBlob(dir, 'f.txt').toString('utf8')).toBe(expectedStaged);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    GIT_IT_TIMEOUT,
  );

  it(
    // 注: reverse 方向でこのバグを踏むのは「後ろのペアだけ選択し、前のペアは未選択のまま残す」
    // 場合(forward とは逆)。実 git で両パターンを試して確認済み(前のペアだけ選択する側は
    // reverse では偶然壊れない — 未選択 '-' が reverse では context 化ではなく丸ごと削除される
    // ため。詳細は上のペアリングのコメント参照)。
    'reverse/unstage: unstaging only the LATER pair of a fully-staged adjacent 2-line replace keeps order correct',
    async () => {
      const { dir, run } = makeRepo();
      try {
        const base = ['line1', 'line2', 'line3', 'line4'].join('\n') + '\n';
        fs.writeFileSync(path.join(dir, 'f.txt'), base);
        run(['add', '-A']);
        run(['commit', '-q', '-m', 'base']);

        const modified = ['line1', 'line2-CHANGED', 'line3-CHANGED', 'line4'].join('\n') + '\n';
        fs.writeFileSync(path.join(dir, 'f.txt'), modified);
        run(['add', '-A']); // 両方の変更をまとめて staged にする

        const diffText = diffLatin1(dir, ['diff', '--cached', '--', 'f.txt']);
        const { header, hunks } = splitDiffHunks(diffText);
        const minusIdx = hunks[0].lines.indexOf('-line3');
        const plusIdx = hunks[0].lines.indexOf('+line3-CHANGED');

        const patch = buildPartialPatchLines(header, hunks, [0], [[minusIdx, plusIdx]], 'reverse');
        await runGitInput(dir, ['apply', '--cached', '--reverse', '-'], Buffer.from(patch, 'latin1'));

        // line3 の変更だけ unstage された(HEAD の値に戻る)。line2-CHANGED は staged のまま
        // (バグ再現時は line1, line3, line2-CHANGED, line4 という壊れた順序になっていた)。
        const expectedStaged = ['line1', 'line2-CHANGED', 'line3', 'line4'].join('\n') + '\n';
        expect(readStagedBlob(dir, 'f.txt').toString('utf8')).toBe(expectedStaged);
        expect(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8')).toBe(modified); // worktree は無変更
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    GIT_IT_TIMEOUT,
  );

  it(
    'reverse/discard: discarding only the LATER pair from the worktree (no --cached) keeps order correct',
    async () => {
      const { dir, run } = makeRepo();
      try {
        const base = ['line1', 'line2', 'line3', 'line4'].join('\n') + '\n';
        fs.writeFileSync(path.join(dir, 'f.txt'), base);
        run(['add', '-A']);
        run(['commit', '-q', '-m', 'base']);

        const modified = ['line1', 'line2-CHANGED', 'line3-CHANGED', 'line4'].join('\n') + '\n';
        fs.writeFileSync(path.join(dir, 'f.txt'), modified); // 未 staged のまま(discard は worktree 差分を逆適用)

        const diffText = diffLatin1(dir, ['diff', '--', 'f.txt']);
        const { header, hunks } = splitDiffHunks(diffText);
        const minusIdx = hunks[0].lines.indexOf('-line3');
        const plusIdx = hunks[0].lines.indexOf('+line3-CHANGED');

        const patch = buildPartialPatchLines(header, hunks, [0], [[minusIdx, plusIdx]], 'reverse');
        await runGitInput(dir, ['apply', '--reverse', '-'], Buffer.from(patch, 'latin1'));

        const expectedWorktree = ['line1', 'line2-CHANGED', 'line3', 'line4'].join('\n') + '\n';
        expect(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8')).toBe(expectedWorktree);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    GIT_IT_TIMEOUT,
  );

  it(
    'non-contiguous ("checkerboard") selection across a 3-pair block picks the right lines in the right order',
    async () => {
      const { dir, run } = makeRepo();
      try {
        const base = ['line1', 'A', 'B', 'C', 'line5'].join('\n') + '\n';
        fs.writeFileSync(path.join(dir, 'f.txt'), base);
        run(['add', '-A']);
        run(['commit', '-q', '-m', 'base']);

        const modified = ['line1', 'A2', 'B2', 'C2', 'line5'].join('\n') + '\n';
        fs.writeFileSync(path.join(dir, 'f.txt'), modified);

        const diffText = diffLatin1(dir, ['diff', '--', 'f.txt']);
        const { header, hunks } = splitDiffHunks(diffText);
        expect(hunks).toHaveLength(1);
        const lineSel = [
          hunks[0].lines.indexOf('-A'),
          hunks[0].lines.indexOf('+A2'),
          hunks[0].lines.indexOf('-C'),
          hunks[0].lines.indexOf('+C2'),
        ];

        const patch = buildPartialPatchLines(header, hunks, [0], [lineSel], 'forward');
        await runGitInput(dir, ['apply', '--cached', '-'], Buffer.from(patch, 'latin1'));

        // A→A2 と C→C2 は反映され、真ん中の B は元のまま残ること
        const expectedStaged = ['line1', 'A2', 'B', 'C2', 'line5'].join('\n') + '\n';
        expect(readStagedBlob(dir, 'f.txt').toString('utf8')).toBe(expectedStaged);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    GIT_IT_TIMEOUT,
  );

  it(
    'm != n (2 deletions -> 3 additions): selecting only the unpaired trailing addition appends it after the untouched lines',
    async () => {
      const { dir, run } = makeRepo();
      try {
        const base = ['line1', 'X1', 'X2', 'line5'].join('\n') + '\n';
        fs.writeFileSync(path.join(dir, 'f.txt'), base);
        run(['add', '-A']);
        run(['commit', '-q', '-m', 'base']);

        const modified = ['line1', 'Y1', 'Y2', 'Y3', 'line5'].join('\n') + '\n';
        fs.writeFileSync(path.join(dir, 'f.txt'), modified);

        const diffText = diffLatin1(dir, ['diff', '--', 'f.txt']);
        const { header, hunks } = splitDiffHunks(diffText);
        expect(hunks).toHaveLength(1);
        expect(hunks[0].lines.filter((l) => l.startsWith('-'))).toEqual(['-X1', '-X2']);
        expect(hunks[0].lines.filter((l) => l.startsWith('+'))).toEqual(['+Y1', '+Y2', '+Y3']);
        // Y3 は 2 つのペア(X1<->Y1, X2<->Y2)のどちらにも属さない「余り」の追加行
        const plusIdx = hunks[0].lines.indexOf('+Y3');

        const patch = buildPartialPatchLines(header, hunks, [0], [[plusIdx]], 'forward');
        await runGitInput(dir, ['apply', '--cached', '-'], Buffer.from(patch, 'latin1'));

        // X1, X2 は選択していないため context のまま残り、Y3 だけが末尾に追加される
        const expectedStaged = ['line1', 'X1', 'X2', 'Y3', 'line5'].join('\n') + '\n';
        expect(readStagedBlob(dir, 'f.txt').toString('utf8')).toBe(expectedStaged);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    GIT_IT_TIMEOUT,
  );

  it(
    'm != n (2 deletions -> 3 additions): selecting only the FIRST pair keeps the untouched tail (pair1 + leftover) in original order',
    async () => {
      const { dir, run } = makeRepo();
      try {
        const base = ['line1', 'X1', 'X2', 'line5'].join('\n') + '\n';
        fs.writeFileSync(path.join(dir, 'f.txt'), base);
        run(['add', '-A']);
        run(['commit', '-q', '-m', 'base']);

        const modified = ['line1', 'Y1', 'Y2', 'Y3', 'line5'].join('\n') + '\n';
        fs.writeFileSync(path.join(dir, 'f.txt'), modified);

        const diffText = diffLatin1(dir, ['diff', '--', 'f.txt']);
        const { header, hunks } = splitDiffHunks(diffText);
        const minusIdx = hunks[0].lines.indexOf('-X1');
        const plusIdx = hunks[0].lines.indexOf('+Y1');

        const patch = buildPartialPatchLines(header, hunks, [0], [[minusIdx, plusIdx]], 'forward');
        await runGitInput(dir, ['apply', '--cached', '-'], Buffer.from(patch, 'latin1'));

        // X1->Y1 だけ反映され、X2(未選択、context のまま残る)が Y1 の後ろに来る
        // (バグ再現時は X2, Y1 の順に化けていた)。Y2/Y3 は未選択のため追加されない。
        const expectedStaged = ['line1', 'Y1', 'X2', 'line5'].join('\n') + '\n';
        expect(readStagedBlob(dir, 'f.txt').toString('utf8')).toBe(expectedStaged);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    GIT_IT_TIMEOUT,
  );

  it(
    'm != n (3 deletions -> 2 additions): selecting only the unpaired trailing deletion removes just that line',
    async () => {
      const { dir, run } = makeRepo();
      try {
        const base = ['line1', 'X1', 'X2', 'X3', 'line5'].join('\n') + '\n';
        fs.writeFileSync(path.join(dir, 'f.txt'), base);
        run(['add', '-A']);
        run(['commit', '-q', '-m', 'base']);

        const modified = ['line1', 'Y1', 'Y2', 'line5'].join('\n') + '\n';
        fs.writeFileSync(path.join(dir, 'f.txt'), modified);

        const diffText = diffLatin1(dir, ['diff', '--', 'f.txt']);
        const { header, hunks } = splitDiffHunks(diffText);
        // X3 は 2 つのペア(X1<->Y1, X2<->Y2)のどちらにも属さない「余り」の削除行
        const minusIdx = hunks[0].lines.indexOf('-X3');

        const patch = buildPartialPatchLines(header, hunks, [0], [[minusIdx]], 'forward');
        await runGitInput(dir, ['apply', '--cached', '-'], Buffer.from(patch, 'latin1'));

        // Y1, Y2 は選択していないため追加されず、X3 だけが取り除かれる
        const expectedStaged = ['line1', 'X1', 'X2', 'line5'].join('\n') + '\n';
        expect(readStagedBlob(dir, 'f.txt').toString('utf8')).toBe(expectedStaged);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    GIT_IT_TIMEOUT,
  );

  it(
    'm != n (3 deletions -> 2 additions): selecting only the FIRST pair keeps the untouched tail (pair1 + leftover) in original order',
    async () => {
      const { dir, run } = makeRepo();
      try {
        const base = ['line1', 'X1', 'X2', 'X3', 'line5'].join('\n') + '\n';
        fs.writeFileSync(path.join(dir, 'f.txt'), base);
        run(['add', '-A']);
        run(['commit', '-q', '-m', 'base']);

        const modified = ['line1', 'Y1', 'Y2', 'line5'].join('\n') + '\n';
        fs.writeFileSync(path.join(dir, 'f.txt'), modified);

        const diffText = diffLatin1(dir, ['diff', '--', 'f.txt']);
        const { header, hunks } = splitDiffHunks(diffText);
        const minusIdx = hunks[0].lines.indexOf('-X1');
        const plusIdx = hunks[0].lines.indexOf('+Y1');

        const patch = buildPartialPatchLines(header, hunks, [0], [[minusIdx, plusIdx]], 'forward');
        await runGitInput(dir, ['apply', '--cached', '-'], Buffer.from(patch, 'latin1'));

        // X1->Y1 だけ反映され、X2・X3(未選択)はそのままの順序で残る
        // (バグ再現時は X2, X3, Y1 の順に化けていた — Y1 が末尾に押し出される)。
        const expectedStaged = ['line1', 'Y1', 'X2', 'X3', 'line5'].join('\n') + '\n';
        expect(readStagedBlob(dir, 'f.txt').toString('utf8')).toBe(expectedStaged);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    GIT_IT_TIMEOUT,
  );

  it(
    'pure insertion of 2 adjacent new lines: selecting only the first keeps the second out',
    async () => {
      const { dir, run } = makeRepo();
      try {
        const base = ['line1', 'line2'].join('\n') + '\n';
        fs.writeFileSync(path.join(dir, 'f.txt'), base);
        run(['add', '-A']);
        run(['commit', '-q', '-m', 'base']);

        const modified = ['line1', 'NEW-A', 'NEW-B', 'line2'].join('\n') + '\n';
        fs.writeFileSync(path.join(dir, 'f.txt'), modified);

        const diffText = diffLatin1(dir, ['diff', '--', 'f.txt']);
        const { header, hunks } = splitDiffHunks(diffText);
        const plusIdx = hunks[0].lines.indexOf('+NEW-A');

        const patch = buildPartialPatchLines(header, hunks, [0], [[plusIdx]], 'forward');
        await runGitInput(dir, ['apply', '--cached', '-'], Buffer.from(patch, 'latin1'));

        const expectedStaged = ['line1', 'NEW-A', 'line2'].join('\n') + '\n';
        expect(readStagedBlob(dir, 'f.txt').toString('utf8')).toBe(expectedStaged);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    GIT_IT_TIMEOUT,
  );

  it(
    'pure deletion of 2 adjacent lines: selecting only the second (later) one deletes just that line',
    async () => {
      const { dir, run } = makeRepo();
      try {
        const base = ['line1', 'OLD-A', 'OLD-B', 'line2'].join('\n') + '\n';
        fs.writeFileSync(path.join(dir, 'f.txt'), base);
        run(['add', '-A']);
        run(['commit', '-q', '-m', 'base']);

        const modified = ['line1', 'line2'].join('\n') + '\n';
        fs.writeFileSync(path.join(dir, 'f.txt'), modified);

        const diffText = diffLatin1(dir, ['diff', '--', 'f.txt']);
        const { header, hunks } = splitDiffHunks(diffText);
        const minusIdx = hunks[0].lines.indexOf('-OLD-B');

        const patch = buildPartialPatchLines(header, hunks, [0], [[minusIdx]], 'forward');
        await runGitInput(dir, ['apply', '--cached', '-'], Buffer.from(patch, 'latin1'));

        const expectedStaged = ['line1', 'OLD-A', 'line2'].join('\n') + '\n';
        expect(readStagedBlob(dir, 'f.txt').toString('utf8')).toBe(expectedStaged);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    GIT_IT_TIMEOUT,
  );

  it(
    'CRLF: partial pair selection within an adjacent 2-line replace preserves byte-exact \\r and correct order',
    async () => {
      const { dir, run } = makeRepo();
      try {
        const base = ['line1', 'line2', 'line3', 'line4'].join('\r\n') + '\r\n';
        fs.writeFileSync(path.join(dir, 'crlf.txt'), base);
        run(['add', '-A']);
        run(['commit', '-q', '-m', 'base']);

        const modified = ['line1', 'line2-MOD', 'line3-MOD', 'line4'].join('\r\n') + '\r\n';
        fs.writeFileSync(path.join(dir, 'crlf.txt'), modified);

        const diffText = diffLatin1(dir, ['diff', '--', 'crlf.txt']);
        const { header, hunks } = splitDiffHunks(diffText);
        expect(hunks[0].lines).toContain('-line2\r');
        expect(hunks[0].lines).toContain('-line3\r');
        const minusIdx = hunks[0].lines.indexOf('-line2\r');
        const plusIdx = hunks[0].lines.indexOf('+line2-MOD\r');

        const patch = buildPartialPatchLines(header, hunks, [0], [[minusIdx, plusIdx]], 'forward');
        await runGitInput(dir, ['apply', '--cached', '-'], Buffer.from(patch, 'latin1'));

        const expectedStaged = ['line1', 'line2-MOD', 'line3', 'line4'].join('\r\n') + '\r\n';
        const stagedBlob = readStagedBlob(dir, 'crlf.txt');
        expect(stagedBlob.toString('latin1')).toBe(expectedStaged);
        expect(stagedBlob.includes(0x0d)).toBe(true);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    GIT_IT_TIMEOUT,
  );

  it(
    'Shift_JIS: partial pair selection within an adjacent 2-line replace preserves byte sequences and correct order',
    async () => {
      const { dir, run } = makeRepo();
      try {
        const baseText = ['一行目', '二行目', '三行目', '四行目'].join('\n') + '\n';
        fs.writeFileSync(path.join(dir, 'sjis.txt'), iconv.encode(baseText, 'shift_jis'));
        run(['add', '-A']);
        run(['commit', '-q', '-m', 'base']);

        const modifiedText = ['一行目', '二行目-変更', '三行目-変更', '四行目'].join('\n') + '\n';
        fs.writeFileSync(path.join(dir, 'sjis.txt'), iconv.encode(modifiedText, 'shift_jis'));

        const diffText = diffLatin1(dir, ['diff', '--', 'sjis.txt']);
        const { header, hunks } = splitDiffHunks(diffText);
        expect(hunks).toHaveLength(1);
        const minusLine = iconv.encode('二行目', 'shift_jis').toString('latin1');
        const plusLine = iconv.encode('二行目-変更', 'shift_jis').toString('latin1');
        const minusIdx = hunks[0].lines.indexOf('-' + minusLine);
        const plusIdx = hunks[0].lines.indexOf('+' + plusLine);
        expect(minusIdx).toBeGreaterThanOrEqual(0);
        expect(plusIdx).toBeGreaterThanOrEqual(0);

        const patch = buildPartialPatchLines(header, hunks, [0], [[minusIdx, plusIdx]], 'forward');
        await runGitInput(dir, ['apply', '--cached', '-'], Buffer.from(patch, 'latin1'));

        const expectedStagedText = ['一行目', '二行目-変更', '三行目', '四行目'].join('\n') + '\n';
        const stagedBlob = readStagedBlob(dir, 'sjis.txt');
        expect(iconv.decode(stagedBlob, 'shift_jis')).toBe(expectedStagedText);
        expect(iconv.decode(stagedBlob, 'shift_jis')).not.toContain('�');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    GIT_IT_TIMEOUT,
  );

  it(
    'no-newline-at-eof marker follows its content line correctly when only the EARLIER pair (not the eof-affecting one) is selected',
    async () => {
      const { dir, run } = makeRepo();
      try {
        fs.writeFileSync(path.join(dir, 'noeof.txt'), 'a\nb\nc'); // 'c' はファイル末尾・改行なし
        run(['add', '-A']);
        run(['commit', '-q', '-m', 'base']);

        fs.writeFileSync(path.join(dir, 'noeof.txt'), 'a\nb-MOD\nc-MOD'); // b, c(末尾) を隣接変更

        const diffText = diffLatin1(dir, ['diff', '--', 'noeof.txt']);
        const { header, hunks } = splitDiffHunks(diffText);
        expect(hunks[0].lines).toContain('\\ No newline at end of file');
        const minusIdx = hunks[0].lines.indexOf('-b');
        const plusIdx = hunks[0].lines.indexOf('+b-MOD');

        // 末尾行(c -> c-MOD)は選択しない -> c は context のまま残り、marker もそれに追従する
        const patch = buildPartialPatchLines(header, hunks, [0], [[minusIdx, plusIdx]], 'forward');
        const check = await runGitInput(dir, ['apply', '--cached', '--check', '-'], Buffer.from(patch, 'latin1'));
        expect(check.toString('utf8')).toBe('');
        await runGitInput(dir, ['apply', '--cached', '-'], Buffer.from(patch, 'latin1'));

        const stagedBlob = readStagedBlob(dir, 'noeof.txt');
        expect(stagedBlob.toString('utf8')).toBe('a\nb-MOD\nc'); // 末尾改行なしのまま c が残る
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    GIT_IT_TIMEOUT,
  );

  it(
    'no-newline-at-eof marker follows its content line correctly when only the LATER (eof-affecting) pair is selected',
    async () => {
      const { dir, run } = makeRepo();
      try {
        fs.writeFileSync(path.join(dir, 'noeof.txt'), 'a\nb\nc');
        run(['add', '-A']);
        run(['commit', '-q', '-m', 'base']);

        fs.writeFileSync(path.join(dir, 'noeof.txt'), 'a\nb-MOD\nc-MOD');

        const diffText = diffLatin1(dir, ['diff', '--', 'noeof.txt']);
        const { header, hunks } = splitDiffHunks(diffText);
        const minusIdx = hunks[0].lines.indexOf('-c');
        const plusIdx = hunks[0].lines.indexOf('+c-MOD');

        // 先頭の b -> b-MOD は選択しない -> b は context のまま。c-MOD だけステージし、
        // 末尾改行なしの marker が正しく c-MOD 側について出力されることを確認する。
        const patch = buildPartialPatchLines(header, hunks, [0], [[minusIdx, plusIdx]], 'forward');
        const check = await runGitInput(dir, ['apply', '--cached', '--check', '-'], Buffer.from(patch, 'latin1'));
        expect(check.toString('utf8')).toBe('');
        await runGitInput(dir, ['apply', '--cached', '-'], Buffer.from(patch, 'latin1'));

        const stagedBlob = readStagedBlob(dir, 'noeof.txt');
        expect(stagedBlob.toString('utf8')).toBe('a\nb\nc-MOD'); // 末尾改行なしのまま c-MOD になる
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    GIT_IT_TIMEOUT,
  );

  it('full-selection of an adjacent multi-line block matches the whole-hunk (null) byte output exactly (regression)', () => {
    // lineSel に「そのハンクの全変更行」を明示的に指定した場合でも、null(全行選択)指定と
    // バイト単位で同一の出力になること(新しいペアリング処理を経由しても崩れないことの確認)。
    const { header, hunks } = splitDiffHunks(MULTI_DIFF);
    const hunk0 = hunks[0]; // [' line1', '-line2', '+line2-MODIFIED', ' line3', ' line4', ' line5']
    const allChangeIndices = hunk0.lines
      .map((l, i) => i)
      .filter((i) => hunk0.lines[i].startsWith('-') || hunk0.lines[i].startsWith('+'));
    const viaNull = buildPartialPatchLines(header, hunks, [0], [null], 'forward');
    const viaExplicit = buildPartialPatchLines(header, hunks, [0], [allChangeIndices], 'forward');
    expect(viaExplicit).toBe(viaNull);
  });
});

/**
 * 2 回目の修正サイクル(reviewer 指摘)の回帰テスト群: `\ No newline at end of file` marker
 * の追随で行が融合するバグ(must-fix)、ハッシュベース楽観ロック(recommended 2/3 → 純関数
 * 抽出は下の describe へ)、末尾番人の位置判定(recommended 5)。
 *
 * marker バグの再現ケースは reviewer が実 HTTP ルート + 実 git で確認したものをそのまま
 * 移植した(ブリーフ記載のシナリオと完全一致)。
 */
describe('transformHunkLines (via buildPartialPatchLines): must-fix — EOF marker line-fusion regression', () => {
  it(
    'forward/stage: selecting only a later addition (+c) while the earlier EOF-fixing pair (-b/+b) is unselected ' +
      'must NOT fuse "b" and "c" into "bc" (reviewer repro: HEAD "a\\nb" no-eof -> worktree "a\\nb\\nc\\n")',
    async () => {
      fs.mkdirSync(TMP_ROOT, { recursive: true });
      const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'marker-fuse-stage-'));
      try {
        const run = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
        run(['init', '-q']);
        run(['config', 'user.email', 'test@test.com']);
        run(['config', 'user.name', 'test']);
        run(['config', 'core.autocrlf', 'false']);
        fs.writeFileSync(path.join(dir, 'f.txt'), 'a\nb'); // 末尾改行なし
        run(['add', '-A']);
        run(['commit', '-q', '-m', 'base']);
        fs.writeFileSync(path.join(dir, 'f.txt'), 'a\nb\nc\n'); // 'c' を追記(末尾改行あり)しただけ

        const diffBuf = execFileSync('git', ['diff', '--', 'f.txt'], { cwd: dir, encoding: 'buffer' });
        const diffText = diffBuf.toString('latin1');
        const { header, hunks } = splitDiffHunks(diffText);
        expect(hunks).toHaveLength(1);
        expect(hunks[0].lines).toEqual([' a', '-b', '\\ No newline at end of file', '+b', '+c', '']);
        const plusCIdx = hunks[0].lines.indexOf('+c');

        // ユーザーは「+c」だけをチェックして選択(-b/+b のペアはチェックしていない)。
        const patch = buildPartialPatchLines(header, hunks, [0], [[plusCIdx]], 'forward');
        const check = await runGitInput(dir, ['apply', '--cached', '--check', '-'], Buffer.from(patch, 'latin1'));
        expect(check.toString('utf8')).toBe(''); // apply 成功は合格の根拠にしない(前提確認のみ)
        await runGitInput(dir, ['apply', '--cached', '-'], Buffer.from(patch, 'latin1'));

        // 修正前は "a\nbc\n"(b と c が改行無しで融合)になっていた(reviewer 実証・本タスクでも
        // 一時的に旧コードへ戻して再現確認済み)。正しくは各行が独立して区切られていること。
        const stagedBlob = execFileSync('git', ['show', ':f.txt'], { cwd: dir, encoding: 'buffer' });
        expect(stagedBlob.toString('latin1')).toBe('a\nb\nc\n');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    GIT_IT_TIMEOUT,
  );

  it(
    'reverse/discard: discarding only "-r" while the EOF-fixing pair sharing its run is unselected ' +
      'must NOT fuse lines (reviewer repro: HEAD "p\\nq\\nr\\ns\\n" -> worktree "p\\nQ" no-eof, discard "-r" only)',
    async () => {
      fs.mkdirSync(TMP_ROOT, { recursive: true });
      const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'marker-fuse-discard-'));
      try {
        const run = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
        run(['init', '-q']);
        run(['config', 'user.email', 'test@test.com']);
        run(['config', 'user.name', 'test']);
        run(['config', 'core.autocrlf', 'false']);
        fs.writeFileSync(path.join(dir, 'f.txt'), 'p\nq\nr\ns\n');
        run(['add', '-A']);
        run(['commit', '-q', '-m', 'base']);
        fs.writeFileSync(path.join(dir, 'f.txt'), 'p\nQ'); // 末尾改行なし。q,r,s 全体が "Q" 1 行に置き換わった形

        const diffBuf = execFileSync('git', ['diff', '--', 'f.txt'], { cwd: dir, encoding: 'buffer' });
        const diffText = diffBuf.toString('latin1');
        const { header, hunks } = splitDiffHunks(diffText);
        expect(hunks[0].lines).toEqual([' p', '-q', '-r', '-s', '+Q', '\\ No newline at end of file', '']);
        const minusRIdx = hunks[0].lines.indexOf('-r');

        // ユーザーは「-r」だけをチェック(q/s/+Q はチェックしていない)。
        const patch = buildPartialPatchLines(header, hunks, [0], [[minusRIdx]], 'reverse');
        const check = await runGitInput(dir, ['apply', '--reverse', '--check', '-'], Buffer.from(patch, 'latin1'));
        expect(check.toString('utf8')).toBe('');
        await runGitInput(dir, ['apply', '--reverse', '-'], Buffer.from(patch, 'latin1'));

        // 修正前は "p\nQr"(Q と r が改行無しで融合)になっていた(reviewer 実証・本タスクでも
        // 一時的に旧コードへ戻して再現確認済み)。
        //
        // 修正後の実バイトは "p\nq\nr\n" — "r" は正しく復元され、行の融合は解消されるが、
        // "q"(未チェック)も一緒に復元され、"+Q"(未チェック)の追加も打ち消される。これは
        // 意図した挙動: "r" の marker(元は "+Q" に付いていた無改行主張)は、"q"/"Q" ペア全体を
        // 選択に引き込まない限り「両側の最終行」という主張を維持できず(この 2 行は別々の
        // テキストであり、単純な EOF 修正には使えないため — 詳細はブリーフ回答参照)、
        // 引き込みなしでは不変条件違反として 500(フェイルクローズド)になっていた。
        // reviewer の方針どおり「関連する EOF 修正ペアを自動的に選択へ引き込む」ことで解決し、
        // 結果として関連ペアも一緒に元に戻る(単独チェックボックスの粒度ちょうどにはならない
        // が、バイトは一切壊れない)。
        const worktree = fs.readFileSync(path.join(dir, 'f.txt'));
        expect(worktree.toString('latin1')).toBe('p\nq\nr\n');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    GIT_IT_TIMEOUT,
  );

  it(
    'guard (fail-closed): a marker attached to a context line with real content after it cannot be auto-fixed ' +
      '(synthetic/adversarial fixture — real git never emits a marker on a non-final context line; this exercises ' +
      'the defensive guard directly, since context lines have no pull-in target)',
    () => {
      // 手書きの(実 git 由来ではない)敵対的フィクスチャ: context 行に marker が付き、
      // その後ろにさらに内容行が続く — 実 git はこの形を絶対に生成しない(context 行の
      // marker は「両側とも最終行」を意味するため、後続行があること自体が矛盾)が、
      // ガードが「引き込む対象が無い(pullIndices=[])」場合に確実に throw することを
      // 確認する目的で意図的に作る。
      const hunk: DiffHunk = {
        header: '@@ -1,2 +1,3 @@',
        lines: [' a', '\\ No newline at end of file', '-b', '+b', '+c', ''],
      };
      const { hunks } = splitDiffHunks([hunk.header, ...hunk.lines].join('\n'));
      const plusCIdx = hunks[0].lines.indexOf('+c');
      expect(() => buildPartialPatchLines('', hunks, [0], [[plusCIdx]], 'forward')).toThrow();
    },
  );
});

/**
 * hashHunk / checkApplyHunksRequest(不具合2/3の恒久回帰テスト): server/index.ts のルートは
 * モジュールスコープに副作用がありルートテストを書けないため(reviewer 指摘)、検証ロジックを
 * 切り出した純関数をここで直接テストする。
 */
describe('hashHunk', () => {
  const hunkA: DiffHunk = { header: '@@ -1,3 +1,3 @@', lines: [' a', '-b', '+B', ' c', ''] };

  it('is deterministic for the same header + lines', () => {
    const again: DiffHunk = { header: hunkA.header, lines: [...hunkA.lines] };
    expect(hashHunk(hunkA)).toBe(hashHunk(again));
  });

  it('changes when any content line changes', () => {
    const changed: DiffHunk = { header: hunkA.header, lines: [' a', '-b', '+B2', ' c', ''] };
    expect(hashHunk(changed)).not.toBe(hashHunk(hunkA));
  });

  it('changes when only the header changes', () => {
    const changed: DiffHunk = { header: '@@ -1,3 +1,4 @@', lines: hunkA.lines };
    expect(hashHunk(changed)).not.toBe(hashHunk(hunkA));
  });

  it(
    'does not collide for distinct Shift_JIS byte sequences that decode to the same (mojibake) utf8 string ' +
      '(不具合2 の核心: utf8 デコードは非可逆なため、utf8 文字列比較では別内容を同一とみなしてしまうことがある)',
    () => {
      // SJIS の「あ」(0x82 0xA0)と「い」(0x82 0xA2) — 1 バイト目が同じ 0x82 のため、
      // どちらも utf8 として不正なマルチバイト列になり、Buffer#toString('utf8') は
      // 同じ置換文字(U+FFFD)の並びに潰れる(reviewer が実測済み。ここでも再確認する)。
      const a = iconv.encode('あ', 'shift_jis').toString('latin1');
      const i = iconv.encode('い', 'shift_jis').toString('latin1');
      // 前提確認: utf8 化すると本当に衝突すること(このテストの意義そのもの)。
      expect(Buffer.from(a, 'latin1').toString('utf8')).toBe(Buffer.from(i, 'latin1').toString('utf8'));
      const hunkWithA: DiffHunk = { header: '@@ -1,1 +1,1 @@', lines: ['-' + a, '+' + a, ''] };
      const hunkWithI: DiffHunk = { header: '@@ -1,1 +1,1 @@', lines: ['-' + a, '+' + i, ''] };
      expect(hashHunk(hunkWithA)).not.toBe(hashHunk(hunkWithI));
    },
  );
});

describe('checkApplyHunksRequest', () => {
  const hunks: DiffHunk[] = [
    { header: '@@ -1,3 +1,3 @@', lines: [' a', '-b', '+B', ' c'] },
    { header: '@@ -10,3 +10,3 @@', lines: [' x', '-y', '+Y', ' z', ''] },
  ];
  const hashes = hunks.map(hashHunk);

  it('accepts a valid request (hunk-level, lines omitted) and echoes lineSelections as undefined', () => {
    const result = checkApplyHunksRequest({
      selected: [0],
      rawLines: undefined,
      expectedHunkCount: 2,
      expectedHunkHashes: [hashes[0]],
      authoritativeHunks: hunks,
    });
    expect(result).toEqual({ ok: true, lineSelections: undefined });
  });

  it('accepts a valid request with a line selection', () => {
    const minusIdx = hunks[0].lines.indexOf('-b');
    const result = checkApplyHunksRequest({
      selected: [0],
      rawLines: [[minusIdx]],
      expectedHunkCount: 2,
      expectedHunkHashes: [hashes[0]],
      authoritativeHunks: hunks,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.lineSelections).toEqual([[minusIdx]]);
  });

  it('rejects (409) when hunkCount does not match the authoritative hunk array', () => {
    const result = checkApplyHunksRequest({
      selected: [0],
      rawLines: undefined,
      expectedHunkCount: 3, // 実際は 2
      expectedHunkHashes: [hashes[0]],
      authoritativeHunks: hunks,
    });
    expect(result).toEqual({ ok: false, status: 409, error: HUNK_CONFLICT_MESSAGE });
  });

  it('rejects (409) when expectedHunkHashes is missing/malformed (fail-closed)', () => {
    for (const bad of [undefined, null, 'not-an-array', [123], [hashes[0], hashes[1]] /* length mismatch for selected=[0] */]) {
      const result = checkApplyHunksRequest({
        selected: [0],
        rawLines: undefined,
        expectedHunkCount: 2,
        expectedHunkHashes: bad,
        authoritativeHunks: hunks,
      });
      expect(result).toEqual({ ok: false, status: 409, error: HUNK_CONFLICT_MESSAGE });
    }
  });

  it(
    'rejects (409) when the hash does not match — unconditionally, even for the hunk-level path (lines omitted). ' +
      'this is the regression test for 不具合3 (previously the hunk-level path had no protection beyond hunkCount)',
    () => {
      const result = checkApplyHunksRequest({
        selected: [0],
        rawLines: undefined, // ハンク単位(全行選択)経路
        expectedHunkCount: 2,
        expectedHunkHashes: ['deadbeef'.repeat(8)], // 明らかに一致しない
        authoritativeHunks: hunks,
      });
      expect(result).toEqual({ ok: false, status: 409, error: HUNK_CONFLICT_MESSAGE });
    },
  );

  it(
    'rejects (409) when a hunk that changed only its body (not its header) is caught — the same scenario ' +
      'that expectedHeaders alone (fix cycle 1) could not detect for the hunk-level path (不具合3)',
    () => {
      // header は同一だが本体(行の内容)だけが変わった権威 diff をシミュレート
      // (外部プロセスによる並行編集で、開始行・行数は変えず内容だけ書き換えたケース)。
      const staleHash = hashHunk(hunks[0]);
      const changedAuthoritative: DiffHunk[] = [
        { header: hunks[0].header, lines: [' a', '-b', '+B-EXTERNAL', ' c'] }, // 内容だけ変化
        hunks[1],
      ];
      const result = checkApplyHunksRequest({
        selected: [0],
        rawLines: undefined,
        expectedHunkCount: 2,
        expectedHunkHashes: [staleHash],
        authoritativeHunks: changedAuthoritative,
      });
      expect(result).toEqual({ ok: false, status: 409, error: HUNK_CONFLICT_MESSAGE });
    },
  );

  it('rejects (400) when lines length does not match selected length', () => {
    const result = checkApplyHunksRequest({
      selected: [0, 1],
      rawLines: [[0]], // selected は長さ 2 なのに 1 要素しかない
      expectedHunkCount: 2,
      expectedHunkHashes: hashes,
      authoritativeHunks: hunks,
    });
    expect(result).toEqual({ ok: false, status: 400, error: expect.any(String) });
  });

  it('rejects (400) when a lines element is malformed (not number[] or null)', () => {
    const result = checkApplyHunksRequest({
      selected: [0],
      rawLines: ['not-an-array'],
      expectedHunkCount: 2,
      expectedHunkHashes: [hashes[0]],
      authoritativeHunks: hunks,
    });
    expect(result).toEqual({ ok: false, status: 400, error: expect.any(String) });
  });

  it('rejects (400) when a line index is out of range', () => {
    const result = checkApplyHunksRequest({
      selected: [0],
      rawLines: [[999]],
      expectedHunkCount: 2,
      expectedHunkHashes: [hashes[0]],
      authoritativeHunks: hunks,
    });
    expect(result).toEqual({ ok: false, status: 400, error: expect.any(String) });
  });

  it(
    'rejects (400, not 500) when the selected lines contain no "+"/"-" line (FYI-7: promotes the former ' +
      'plain-Error-deep-in-transformHunkLines/500 to an early 400)',
    () => {
      const ctxIdx = hunks[0].lines.indexOf(' a');
      const result = checkApplyHunksRequest({
        selected: [0],
        rawLines: [[ctxIdx]], // context 行の添字だけを選択(add/del が 1 つも無い)
        expectedHunkCount: 2,
        expectedHunkHashes: [hashes[0]],
        authoritativeHunks: hunks,
      });
      expect(result).toEqual({ ok: false, status: 400, error: expect.any(String) });
    },
  );
});

/**
 * 末尾番人の判定(不具合5・recommended 5): `git config diff.suppressBlankEmpty true` の
 * 環境では、空行の context 行が `' '` ではなく空文字列そのもので出力される(実 git で確認済み。
 * これは splitDiffHunks の「末尾は '' が番人」という前提と衝突する)。番人は値ではなく
 * 「実際に選択元 hunks 配列で最後のハンクの、最後の要素という位置」で判定する。
 */
describe('transformHunkLines (via buildPartialPatchLines): EOF sentinel is positional, not value-based (fix cycle 2)', () => {
  it(
    'a blank context line mid-hunk (diff.suppressBlankEmpty=true) is treated as context, not the EOF sentinel, ' +
      'and survives a partial line selection correctly',
    async () => {
      fs.mkdirSync(TMP_ROOT, { recursive: true });
      const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'blank-ctx-mid-'));
      try {
        const run = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
        run(['init', '-q']);
        run(['config', 'user.email', 'test@test.com']);
        run(['config', 'user.name', 'test']);
        run(['config', 'core.autocrlf', 'false']);
        run(['config', 'diff.suppressBlankEmpty', 'true']);
        fs.writeFileSync(path.join(dir, 'f.txt'), 'line1\n\nline3\nline4\n');
        run(['add', '-A']);
        run(['commit', '-q', '-m', 'base']);
        fs.writeFileSync(path.join(dir, 'f.txt'), 'line1\n\nline3-MOD\nline4\n');

        const diffBuf = execFileSync('git', ['diff', '--', 'f.txt'], { cwd: dir, encoding: 'buffer' });
        const diffText = diffBuf.toString('latin1');
        const { header, hunks } = splitDiffHunks(diffText);
        expect(hunks).toHaveLength(1);
        // 実 git で確認済みの生の行(空行 context がまさに '' として現れる)。
        expect(hunks[0].lines).toEqual([' line1', '', '-line3', '+line3-MOD', ' line4', '']);

        const minusIdx = hunks[0].lines.indexOf('-line3');
        const plusIdx = hunks[0].lines.indexOf('+line3-MOD');
        const patch = buildPartialPatchLines(header, hunks, [0], [[minusIdx, plusIdx]], 'forward');
        const check = await runGitInput(dir, ['apply', '--cached', '--check', '-'], Buffer.from(patch, 'latin1'));
        expect(check.toString('utf8')).toBe('');
        await runGitInput(dir, ['apply', '--cached', '-'], Buffer.from(patch, 'latin1'));

        const stagedBlob = execFileSync('git', ['show', ':f.txt'], { cwd: dir, encoding: 'buffer' });
        // 空行が正しく維持され、line3 だけが変更されていること(旧コードは '' を番人と
        // 誤認して行数がずれ、"不明な diff 行です" で 500 になっていた)。
        expect(stagedBlob.toString('latin1')).toBe('line1\n\nline3-MOD\nline4\n');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    GIT_IT_TIMEOUT,
  );

  it(
    'a blank context line at the tail of a NON-final hunk (diff.suppressBlankEmpty=true) is treated as context, ' +
      'not mistaken for the trailing-newline sentinel of the whole hunks array',
    async () => {
      fs.mkdirSync(TMP_ROOT, { recursive: true });
      const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'blank-ctx-nonfinal-tail-'));
      try {
        const run = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
        run(['init', '-q']);
        run(['config', 'user.email', 'test@test.com']);
        run(['config', 'user.name', 'test']);
        run(['config', 'core.autocrlf', 'false']);
        run(['config', 'diff.suppressBlankEmpty', 'true']);

        const baseLines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
        baseLines[4] = ''; // line5: 空行(hunk1 の context 末尾に来るよう位置調整)
        fs.writeFileSync(path.join(dir, 'f.txt'), baseLines.join('\n') + '\n');
        run(['add', '-A']);
        run(['commit', '-q', '-m', 'base']);

        const modifiedLines = [...baseLines];
        modifiedLines[1] = 'line2-MOD'; // hunk1 側の変更(空行はそのまま line5 に残る)
        modifiedLines[14] = 'line15-MOD'; // 離れた位置の変更 -> 別ハンク(hunk2)になる
        fs.writeFileSync(path.join(dir, 'f.txt'), modifiedLines.join('\n') + '\n');

        const diffBuf = execFileSync('git', ['diff', '--', 'f.txt'], { cwd: dir, encoding: 'buffer' });
        const diffText = diffBuf.toString('latin1');
        const { header, hunks } = splitDiffHunks(diffText);
        expect(hunks).toHaveLength(2);
        // hunk1(非最終ハンク)の最後の要素が空行 context ('') であること(実 git で確認済み)。
        expect(hunks[0].lines[hunks[0].lines.length - 1]).toBe('');
        expect(hunks[0].lines.filter((l) => l === '')).toHaveLength(1); // 番人と紛れて 2 つにならない

        const minusIdx = hunks[0].lines.indexOf('-line2');
        const plusIdx = hunks[0].lines.indexOf('+line2-MOD');
        // hunk1(非最終ハンク)だけを部分選択で適用する。isLastHunk=false のパスを通る。
        const patch = buildPartialPatchLines(header, hunks, [0], [[minusIdx, plusIdx]], 'forward');
        // 生成された @@ ヘッダーの行数が正しいこと(値ベースで番人と誤認すると、空行 context
        // が oldLines/newLines のカウントから脱落し "@@ -1,4 +1,4 @@" のように 1 少なく
        // 計算される — バイト内容が偶然一致しても、この内部不整合は git apply の fuzzy
        // マッチで見逃され得るため、ヘッダーの数値そのものを別途検証する)。
        expect(patch).toContain('@@ -1,5 +1,5 @@');
        const check = await runGitInput(dir, ['apply', '--cached', '--check', '-'], Buffer.from(patch, 'latin1'));
        expect(check.toString('utf8')).toBe('');
        await runGitInput(dir, ['apply', '--cached', '-'], Buffer.from(patch, 'latin1'));

        const stagedBlob = execFileSync('git', ['show', ':f.txt'], { cwd: dir, encoding: 'buffer' });
        const expectedStagedLines = [...baseLines];
        expectedStagedLines[1] = 'line2-MOD'; // line15 の変更(hunk2、未選択)は含まれない
        expect(stagedBlob.toString('latin1')).toBe(expectedStagedLines.join('\n') + '\n');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    GIT_IT_TIMEOUT,
  );
});

/**
 * 3 回目の修正サイクル(reviewer 指摘 N-1)の回帰テスト群: 「引き込みだけで常に解消する」
 * という 2 回目時点の前提が誤りだったケース(marker が選択済みの `+`/`-` 行(context 化
 * されていない)に付いた状態で、反対側の未選択 leftover が後ろに来て矛盾するケース)。
 * この場合は引き込み(既に選択済みのため何も増えず 500)ではなく、その行自身の marker
 * を破棄するのが正しい(reviewer 実証・本テストで実 git 再現)。
 */
describe('transformHunkLines (via buildPartialPatchLines): N-1 — marker suppression for genuine (non-context) change lines', () => {
  it(
    'reviewer repro: selecting "-g" and "+e" (both genuinely kept, not context-converted) while the ' +
      'unselected leftover "-b" (with its own EOF marker) follows must NOT over-reject with 500 ' +
      '(HEAD "d\\nd\\ne\\nf\\na\\na\\ng\\nb" no-eof -> worktree "d\\nd\\ne\\nf\\na\\na\\ne" no-eof)',
    async () => {
      fs.mkdirSync(TMP_ROOT, { recursive: true });
      const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'n1-marker-suppress-'));
      try {
        const run = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
        run(['init', '-q']);
        run(['config', 'user.email', 'test@test.com']);
        run(['config', 'user.name', 'test']);
        run(['config', 'core.autocrlf', 'false']);
        fs.writeFileSync(path.join(dir, 'f.txt'), 'd\nd\ne\nf\na\na\ng\nb'); // 末尾改行なし
        run(['add', '-A']);
        run(['commit', '-q', '-m', 'base']);
        fs.writeFileSync(path.join(dir, 'f.txt'), 'd\nd\ne\nf\na\na\ne'); // 末尾改行なし

        const diffBuf = execFileSync('git', ['diff', '--', 'f.txt'], { cwd: dir, encoding: 'buffer' });
        const diffText = diffBuf.toString('latin1');
        const { header, hunks } = splitDiffHunks(diffText);
        expect(hunks[0].lines).toEqual([
          ' f',
          ' a',
          ' a',
          '-g',
          '-b',
          '\\ No newline at end of file',
          '+e',
          '\\ No newline at end of file',
          '',
        ]);
        const minusGIdx = hunks[0].lines.indexOf('-g');
        const plusEIdx = hunks[0].lines.indexOf('+e');

        // 修正前(2 回目サイクル)はここで 500 "末尾に改行の無い行の選択が不整合です" を
        // 投げていた(過剰拒否。reviewer がランダム 97 ケース中 3 件で実証)。
        const patch = buildPartialPatchLines(header, hunks, [0], [[minusGIdx, plusEIdx]], 'forward');
        const check = await runGitInput(dir, ['apply', '--cached', '--check', '-'], Buffer.from(patch, 'latin1'));
        expect(check.toString('utf8')).toBe('');
        await runGitInput(dir, ['apply', '--cached', '-'], Buffer.from(patch, 'latin1'));

        // g -> e の置換だけが反映され、b はそのまま残ること(拡大なし)。
        const stagedBlob = execFileSync('git', ['show', ':f.txt'], { cwd: dir, encoding: 'buffer' });
        expect(stagedBlob.toString('latin1')).toBe('d\nd\ne\nf\na\na\ne\nb');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    GIT_IT_TIMEOUT,
  );

  it(
    'self-discovered symmetric case (reverse direction): selecting only "-y" (genuinely kept, marker attached) ' +
      'while unselected leftover additions ("+Y2"/"+Y3", becoming context in reverse) follow must NOT over-reject ' +
      '(HEAD "x\\ny" no-eof -> staged "x\\nY1\\nY2\\nY3\\n", unstage "-y" only)',
    async () => {
      fs.mkdirSync(TMP_ROOT, { recursive: true });
      const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'n1-marker-suppress-reverse-'));
      try {
        const run = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
        run(['init', '-q']);
        run(['config', 'user.email', 'test@test.com']);
        run(['config', 'user.name', 'test']);
        run(['config', 'core.autocrlf', 'false']);
        fs.writeFileSync(path.join(dir, 'f.txt'), 'x\ny'); // 末尾改行なし
        run(['add', '-A']);
        run(['commit', '-q', '-m', 'base']);
        fs.writeFileSync(path.join(dir, 'f.txt'), 'x\nY1\nY2\nY3\n'); // y -> Y1,Y2,Y3、末尾改行あり
        run(['add', '-A']); // 全体を staged にする

        const diffBuf = execFileSync('git', ['diff', '--cached', '--', 'f.txt'], { cwd: dir, encoding: 'buffer' });
        const diffText = diffBuf.toString('latin1');
        const { header, hunks } = splitDiffHunks(diffText);
        expect(hunks[0].lines).toEqual([' x', '-y', '\\ No newline at end of file', '+Y1', '+Y2', '+Y3', '']);
        const minusYIdx = hunks[0].lines.indexOf('-y');

        // -y だけを選択して unstage(Y1/Y2/Y3 の追加はすべて staged のまま残す)。
        const patch = buildPartialPatchLines(header, hunks, [0], [[minusYIdx]], 'reverse');
        const check = await runGitInput(dir, ['apply', '--cached', '--reverse', '--check', '-'], Buffer.from(patch, 'latin1'));
        expect(check.toString('utf8')).toBe('');
        await runGitInput(dir, ['apply', '--cached', '--reverse', '-'], Buffer.from(patch, 'latin1'));

        const stagedBlob = execFileSync('git', ['show', ':f.txt'], { cwd: dir, encoding: 'buffer' });
        expect(stagedBlob.toString('latin1')).toBe('x\ny\nY1\nY2\nY3\n');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    GIT_IT_TIMEOUT,
  );
});

/**
 * N-2(コメント訂正の裏取り): 実 git は genuine context 行にも EOF marker を付ける
 * (最終行が未変更かつ末尾改行が無い場合)。この入力自体は正しく処理できることを実証する
 * (2 回目サイクル時点のコメントは「context 行に marker は付かない」という誤った前提を
 * 書いていたが、処理そのものは元々正しく動いていた — marker が常に真の EOF にあるため)。
 */
describe('transformHunkLines (via buildPartialPatchLines): N-2 — genuine context-line EOF marker is handled correctly', () => {
  it(
    'a marker attached to an unchanged trailing context line (both HEAD and worktree lack a final ' +
      'newline) is preserved correctly when the preceding pair is partially staged ' +
      '(reviewer repro: HEAD "a\\nb" no-eof -> worktree "X\\nb" no-eof)',
    async () => {
      fs.mkdirSync(TMP_ROOT, { recursive: true });
      const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'n2-ctx-marker-'));
      try {
        const run = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
        run(['init', '-q']);
        run(['config', 'user.email', 'test@test.com']);
        run(['config', 'user.name', 'test']);
        run(['config', 'core.autocrlf', 'false']);
        fs.writeFileSync(path.join(dir, 'f.txt'), 'a\nb'); // 末尾改行なし
        run(['add', '-A']);
        run(['commit', '-q', '-m', 'base']);
        fs.writeFileSync(path.join(dir, 'f.txt'), 'X\nb'); // 末尾改行なし、b は不変

        const diffBuf = execFileSync('git', ['diff', '--', 'f.txt'], { cwd: dir, encoding: 'buffer' });
        const diffText = diffBuf.toString('latin1');
        const { header, hunks } = splitDiffHunks(diffText);
        // ' b' という genuine context 行に marker が付いていること(実 git で確認済み)。
        expect(hunks[0].lines).toEqual(['-a', '+X', ' b', '\\ No newline at end of file', '']);

        const minusIdx = hunks[0].lines.indexOf('-a');
        const plusIdx = hunks[0].lines.indexOf('+X');
        const patch = buildPartialPatchLines(header, hunks, [0], [[minusIdx, plusIdx]], 'forward');
        const check = await runGitInput(dir, ['apply', '--cached', '--check', '-'], Buffer.from(patch, 'latin1'));
        expect(check.toString('utf8')).toBe('');
        await runGitInput(dir, ['apply', '--cached', '-'], Buffer.from(patch, 'latin1'));

        const stagedBlob = execFileSync('git', ['show', ':f.txt'], { cwd: dir, encoding: 'buffer' });
        expect(stagedBlob.toString('latin1')).toBe('X\nb'); // 末尾改行なしのまま正しく反映
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    GIT_IT_TIMEOUT,
  );
});
