/**
 * git diff (1 ファイル分の unified diff テキスト) をハンク単位に分解・再組立てする純関数群。
 * child_process 等の I/O には依存しない。呼び出し側は latin1 文字列(Buffer.toString('latin1'))
 * を渡す前提 — ここでは内容のデコード/正規化は一切行わず、バイト列をそのまま素通しする
 * (UTF-8 の日本語も Shift_JIS も latin1 では 1 バイト = 1 文字として保持されるため、
 * split/join だけならエンコーディングを意識せずバイト保存で扱える)。
 *
 * 改行の扱い: 分割・再組立ては `\n` のみを行区切りとして扱う。`\r` (CRLF ファイルの diff で
 * 各行末に付く) は行の内容の一部として保持し、決して除去・付与しない。
 */

/** ハンク 1 個分。header は `@@ -a,b +c,d @@ ...` の行そのもの。lines はその後続の生行
 * (`\n` を含まない。`\r` は含み得る)。`\ No newline at end of file` 行もここに含まれる。 */
export interface DiffHunk {
  header: string;
  lines: string[];
}

/**
 * git diff 1 ファイル分の unified diff テキストを、ファイルヘッダー(最初の `@@ ` 行より前の
 * 全行)とハンク配列に分解する。
 *
 * 行区切りは `\n` のみで判定する(`diffText.split('\n')` と等価)ため、末尾に `\n` があるか
 * どうかは配列の最後の要素が空文字列かどうかに反映され、buildPartialPatch で全ハンクを
 * 選択して再組立てすればバイト単位で元のテキストに戻る。
 */
export function splitDiffHunks(diffText: string): { header: string; hunks: DiffHunk[] } {
  const rawLines = diffText.split('\n');
  const headerLines: string[] = [];
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;

  for (const line of rawLines) {
    if (line.startsWith('@@ ')) {
      current = { header: line, lines: [] };
      hunks.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      headerLines.push(line);
    }
  }

  return { header: headerLines.join('\n'), hunks };
}

/**
 * 選択インデックス(hunks 配列に対する昇順の添字)のハンクだけを含む適用可能なパッチテキストを
 * 組み立てる。ハンク単位の選択では各ハンクが自己完結している(pre-image の行番号を基準に
 * 独立して当たる)ため、`@@` 行の行数を再計算する必要はない。
 *
 * selected が空なら Error を投げる(git apply に空パッチを渡すと紛らわしい失敗になるため、
 * 呼び出し側の意図しないステージ操作をここで止める)。
 */
export function buildPartialPatch(header: string, hunks: DiffHunk[], selected: number[]): string {
  if (selected.length === 0) {
    throw new Error('ハンクが選択されていません');
  }
  for (const idx of selected) {
    if (idx < 0 || idx >= hunks.length || !Number.isInteger(idx)) {
      throw new Error(`不正なハンクインデックスです: ${idx}`);
    }
  }

  const parts: string[] = [];
  if (header !== '') parts.push(header);
  for (const idx of selected) {
    const hunk = hunks[idx];
    parts.push([hunk.header, ...hunk.lines].join('\n'));
  }
  let result = parts.join('\n');

  // 選択した最後のハンクが元のファイル内で最後のハンクでない場合、その直後には本来
  // 次のハンクの `@@` 行へ続く改行があった(hunk.lines は自己完結のためその改行を
  // 保持していない)。省いた以上、末尾を明示的に改行終端しないと `git apply` が
  // 最終行を未終端とみなして "corrupt patch" で拒否する(実 git で確認済み)。
  // 選択した最後のハンクが実際にファイル最後のハンクなら、その hunk.lines は元の
  // diffText の末尾(改行の有無を含む)をそのまま保持しているため何もしない。
  const lastSelectedIdx = selected[selected.length - 1];
  if (lastSelectedIdx !== hunks.length - 1) {
    result += '\n';
  }
  return result;
}
