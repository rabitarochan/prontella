/**
 * git diff (1 ファイル分の unified diff テキスト) をハンク単位に分解・再組立てする純関数群。
 * child_process 等の I/O には依存しない。呼び出し側は latin1 文字列(Buffer.toString('latin1'))
 * を渡す前提 — ここでは内容のデコード/正規化は一切行わず、バイト列をそのまま素通しする
 * (UTF-8 の日本語も Shift_JIS も latin1 では 1 バイト = 1 文字として保持されるため、
 * split/join だけならエンコーディングを意識せずバイト保存で扱える)。
 *
 * 改行の扱い: 分割・再組立ては `\n` のみを行区切りとして扱う。`\r` (CRLF ファイルの diff で
 * 各行末に付く) は行の内容の一部として保持し、決して除去・付与しない。
 *
 * このファイルは POST /api/git/apply-hunks の検証ロジック(lines 検証・楽観ロックの
 * ハッシュ照合・409/400 判定)も抱える(`checkApplyHunksRequest`)。server/index.ts は
 * モジュールスコープに副作用(`app.listen`・PtyManager 起動)があり supertest 等の
 * ルートテストを書けないため、検証ロジックだけを純関数としてここに切り出し、vitest で
 * 直接テストできるようにしている。
 */

import { createHash } from 'node:crypto';

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

/**
 * `git apply` にパッチを渡すときの適用方向。'forward' は前進適用(`git apply --cached`。
 * scope='stage')、'reverse' は逆適用(`--cached --reverse` / `--reverse`。
 * scope='unstage'/'discard')。行単位選択で未選択行をどう扱うかはこの方向で逆転する
 * (下記 transformHunkLines 参照。実 git で実測して確定した対応関係)。
 */
export type ApplyDirection = 'forward' | 'reverse';

interface ParsedHunkHeader {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** `@@ ... @@` の後続文字列(関数名などのコンテキストヒント)。先頭スペースを含め生のまま保持する。 */
  trailing: string;
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function parseHunkHeader(header: string): ParsedHunkHeader {
  const m = HUNK_HEADER_RE.exec(header);
  if (!m) throw new Error(`ハンクヘッダーの形式が不正です: ${header}`);
  return {
    oldStart: Number(m[1]),
    // git の unified diff 仕様: 該当範囲が 1 行のとき `,n` は省略される(実 git で確認済み。
    // 例: `@@ -1 +1 @@`)。省略時は 1 行として扱う。
    oldLines: m[2] !== undefined ? Number(m[2]) : 1,
    newStart: Number(m[3]),
    newLines: m[4] !== undefined ? Number(m[4]) : 1,
    trailing: m[5],
  };
}

function formatCount(start: number, lines: number): string {
  // 逆に 1 行のときだけ `,n` を省略する。実 git の出力に合わせた(0 行や 2 行以上は常に付ける)。
  return lines === 1 ? String(start) : `${start},${lines}`;
}

function formatHunkHeader(oldStart: number, oldLines: number, newStart: number, newLines: number, trailing: string): string {
  return `@@ -${formatCount(oldStart, oldLines)} +${formatCount(newStart, newLines)} @@${trailing}`;
}

/** transformHunkLines の内部表現。hunk.lines の 1 実内容行(`' '`/`'-'`/`'+'` のいずれか)を、
 * 直後に続く `\ No newline at end of file` 行(あれば)込みで保持する。marker は「この行が
 * 出力に残るときだけ一緒に出す」ための付随データであり、以下のペアリング処理で行が
 * 別の位置へ動いても常に元の内容行にくっついていく。 */
interface ParsedHunkContentLine {
  /** hunk.lines 配列への添字。lineSel(呼び出し側の選択集合)と突き合わせるために使う。 */
  hunkIndex: number;
  prefix: ' ' | '-' | '+';
  /** prefix を含む生の行(例: '-line2')。 */
  raw: string;
  marker: string | null;
}

/**
 * 1 ハンク内の一部の行だけを選択したときの内容変換。
 *
 * 未選択行の扱いは適用方向で逆転する(実 git で実測して確認済み。scratchpad の一時
 * リポジトリーで `git apply --cached --check` / 実適用まで通して検証した):
 *
 * - forward (`git apply --cached`。scope='stage'): pre-image は diff の旧側。
 *   未選択の `-` 行はその行が結果にも残るため context 行 `' '` に変換する。
 *   未選択の `+` 行は結果に残らないため丸ごと削除する。
 * - reverse (`--cached --reverse` / `--reverse`。scope='unstage'/'discard'): git がパッチを
 *   反転するため pre-image は diff の新側になる。未選択の `+` 行は index/worktree に
 *   既に存在し結果にも残るため context 行 `' '` に変換する。未選択の `-` 行は丸ごと削除する。
 *
 * context 行(`' '` 始まり)は常に保持する。
 *
 * ## 行の並び順(過去のデータ破壊バグの修正箇所)
 *
 * git diff は「変更ブロック」(削除行の連続 → 追加行の連続、という並び)を常にこの順で
 * 出力する(実 git で確認済み。削除数 m と追加数 n が異なる場合も同様に「削除 m 行が
 * 全部先、追加 n 行が全部後」)。この生の行順のまま各行を独立に context 化/削除すると、
 * 変更ブロックの途中(削除ブロックと追加ブロックの境界)で選択が割れたときに
 * 適用後のファイルの行順が壊れる。理由: git がハンク本文から旧側/新側を復元する際、
 * 旧側は「'+' 以外の行を出現順に読む」、新側は「'-' 以外の行を出現順に読む」という
 * 単純な線形フィルターで行う。したがって、context 化した行の出力上の位置が
 * そのまま新側の並び順に反映されてしまう。
 *
 * 修正方針: 変更ブロックを「削除行配列 D[]」「追加行配列 A[]」に分解し、
 * `k = min(D.length, A.length)` 個の「ペア」(D[i], A[i])を i=0..k-1 の順で処理し、
 * 各ペアの中で D 側→A 側の順に出力する(この対内の順序自体は正しさに影響しない。
 * 影響するのはペア同士の順序で、これは常に i の昇順を保つ)。こうすると:
 * - 旧側(非 '+' 行)を出現順に読むと常に D[0], D[1], ..., D[m-1] の順になる
 *   (各ペアが D 側を独立して出すため。実ファイルの並びと必ず一致する)
 * - 新側(非 '-' 行)を出現順に読むと、選択されたペアは A[i]、未選択のペアは D[i]
 *   (forward の場合)が、i の昇順で並ぶ — これが意図した post-image の並びそのもの
 *
 * D と A の個数が異なる場合(削除 2 行→追加 3 行等)は、k 個のペアを処理したあとの
 * 残り(D[k..] または A[k..]。どちら側が長くても片方しか残らない)を、元の配列内の
 * 相対順序を保ったまま単独行として追加で処理する(選択/方向に応じた通常の 1 行変換)。
 * 残りは常に「ペアより後ろ」に位置する要素(元の生の並びで D[]/A[] それぞれの末尾側)
 * なので、ペア処理の後に追加してもそれぞれの配列内の順序(延いては旧側/新側の並び)は
 * 崩れない(m 個の削除・n 個の追加を持つブロックで実 git 実適用まで検証済み。
 * server/diffPatch.test.ts の m≠n ケース参照)。
 *
 * ペアの中身が 1 行も選択されていない/両方選択されている場合は、既存の単純な
 * per-line ルール(選択なら維持、未選択なら方向に応じて context 化/削除)がそのまま
 * 適用される。つまりこの並び替えは**どの行がどう変換されるかの判定ロジックには
 * 一切手を加えず、出力する順序だけを変える**(削除行の連続が単独の変更ブロックの
 * 場合や、追加行のみのブロックの場合は k=0 になり、元コードと同じ挙動に帰着する)。
 *
 * ## `\ No newline at end of file` marker の扱い(2 回目の修正サイクルで発覚した破壊経路)
 *
 * marker(`'\'` 始まりの行)は「直前の内容行が、当該側(old/new/両方)の最終行であり
 * 改行が無い」という**強い主張**を持つ。この主張は marker が付いた内容行の出力上の
 * **位置**に強く依存する: git は non-'-' 行(new 側)・non-'+' 行(old 側)をそれぞれ
 * 出現順に読んで画像を復元するため、marker の直後の位置に、その marker が主張する側の
 * 内容行が**もう無い**ことが前提になる。
 *
 * 単純にペアリング/leftover 処理で各行を「維持 or context 化 or 削除」するだけでは、
 * marker 付きの `-` 行が(未選択のため)forward で context 化されたのに、その後ろに
 * 別ペアの選択済み `+` 行が続く、という配置が起こり得る。context 化は「old にも new にも
 * 残る」という主張へ意味を**拡張**してしまうため、marker が本来 old 側だけに限定していた
 * 主張が new 側にも及んでしまい、実際には new 側にまだ内容が続くのに矛盾する
 * (実 git で確認済み: `git apply` は 200/success を返しつつ、marker の直後の行を
 * 改行無しで融合させる — "a\nb" + "+c" 選択のみで index が "a\nbc\n" になる等)。
 *
 * 対処は 2 段構え(reviewer 指摘):
 * 1. **フェイルクローズドなガード**: 出力を組み立てたあと、各 marker について「その
 *    marker が主張する側(old/new/両方)の内容行が、marker より後ろに存在しないか」を
 *    検証する(`buildHunkOutputOnce` 末尾)。違反があれば `{ ok: false }` を返し、
 *    このハンクの変換全体を諦める(呼び出し側が最終的に throw して 500/400 で止まる —
 *    黙って壊れたバイトを返すことは無くなる)。
 * 2. **矛盾の解消は 2 通りを使い分ける**(3 回目の修正サイクルで判明。2 回目時点では
 *    「自動引き込みだけで常に解消する」と考えていたが、reviewer のプロパティテストで
 *    反例が見つかった — 詳細は下記):
 *
 *    a. **marker が context 行(`' '` 始まり)に付いている場合**: この行はもともと
 *       未選択の `-`/`+` が context 化されたもので、marker の主張が「片側」から
 *       「両側」へ**拡張**されてしまっている。これを正すには、その行を「維持(単独側の
 *       主張)」に戻す必要があり、ペア全体(削除↔追加の対応する要素。ペアが無い
 *       leftover なら自分自身)の hunkIndex を **pullIndices として実効選択に引き込む**。
 *       単独側の並び順は D[]/A[] 順序不変条件により常に保存されるため、たいていの
 *       ケースはこれで矛盾が解消する(実 git で確認済み: `-b`(marker 付き)/`+b` の
 *       ペアを引き込むと `+c` の選択だけで "a\nb\nc\n" が正しく得られる)。
 *    b. **marker が実際に維持された `-`/`+` 行(選択済み、context 化されていない)に
 *       付いている場合**: この行の主張(「単独側の最終行」)自体は正しいが、後続の
 *       **leftover(ペアの相手が無い側の残り行)が未選択で context 化され、marker の
 *       主張側と同じ側にカウントされてしまう**ことで矛盾が起こる。ペア並び順不変条件
 *       (D[]/A[] それぞれの末尾側に leftover を置く設計)の**構造上の裏面**として、
 *       「削除ブロックの一部を選択・追加ブロックの一部を選択」した際、選択された側の
 *       ペアの marker が、反対側の未選択 leftover(後ろに配置される)によって踏まれる
 *       ケースが存在する(reviewer がランダム 97 ケース中 3 件で実証。いずれも `+`/`-`
 *       行 marker のケースだった。実 git で HEAD "d\nd\ne\nf\na\na\ng\nb"(末尾改行無し)
 *       → worktree "d\nd\ne\nf\na\na\ne"(末尾改行無し)で "-g"+"+e" だけ選択する
 *       ケースを再現・確認済み)。この場合、その行は「その側の最終行」ではなく
 *       なった(反対側の leftover が後ろに来て、実際には改行を持つ)ので、**marker を
 *       落とす**のが意味的に正しい(引き込もうとしても、既に選択済みで何も増えず
 *       500 になっていた — 過剰拒否)。落とす対象は「その marker を持つ内容行自身」
 *       の hunkIndex(`suppressedMarkers` に追加し、再試行時にその行の marker だけを
 *       出力しない)。
 *
 *    判定は「違反した marker が付いている行の**出力上のプレフィックス**」で行う:
 *    `' '`(context)なら a(引き込み)、`'-'`/`'+'`(維持された変更行)なら b(破棄)。
 *    どちらの対処でも解消しない場合は上のガードで最終的に throw する
 *    (実効選択・抑止集合はいずれも単調増加のため、有限回で解消するか判定不能に到達する)。
 */

/** ハンク本文組み立て 1 回分の試行結果。marker 不変条件に違反した場合は、解消方法を
 * 示して成功しなかったことを表す。`pullIn`: ペア(または leftover 単独)を実効選択へ
 * 引き込んで context 化を防ぐ。`suppress`: 維持された変更行自身の marker を破棄する
 * (上記ファイル冒頭コメントの方針 2-a / 2-b)。 */
type HunkOutputAttempt =
  | { ok: true; lines: string[]; oldLines: number; newLines: number }
  | { ok: false; action: 'pullIn'; pullIndices: number[] }
  | { ok: false; action: 'suppress'; hunkIndex: number };

function buildHunkOutputOnce(
  parsed: ParsedHunkContentLine[],
  selected: Set<number>,
  direction: ApplyDirection,
  /** この hunkIndex の内容行が持つ marker は、行自体は維持したまま出力しない
   * (方針 2-b の再試行で使う)。 */
  suppressedMarkers: ReadonlySet<number>,
): HunkOutputAttempt {
  const outLines: string[] = [];
  let oldLines = 0;
  let newLines = 0;

  interface MarkerEvent {
    /** outLines 上で、marker が付いた内容行そのものの添字(marker 行はその直後)。 */
    contentPos: number;
    claimsOld: boolean;
    claimsNew: boolean;
    /** 方針 2-a: 違反時にこの pullIndices を実効選択へ引き込む(この行が context 化
     * された場合のみ意味を持つ)。 */
    pullIndices: number[];
    /** 方針 2-b: 違反時にこの hunkIndex の marker を抑止する(この行が維持された
     * 変更行である場合のみ意味を持つ)。 */
    ownerHunkIndex: number;
  }
  const markerEvents: MarkerEvent[] = [];

  const pushLine = (raw: string, marker: string | null, ownerHunkIndex: number, pullIndices: number[]): void => {
    const contentPos = outLines.length;
    outLines.push(raw);
    const effectiveMarker = marker !== null && !suppressedMarkers.has(ownerHunkIndex) ? marker : null;
    if (effectiveMarker !== null) {
      outLines.push(effectiveMarker);
      const prefix = raw[0];
      markerEvents.push({
        contentPos,
        claimsOld: prefix === ' ' || prefix === '-',
        claimsNew: prefix === ' ' || prefix === '+',
        pullIndices,
        ownerHunkIndex,
      });
    }
  };

  let idx = 0;
  while (idx < parsed.length) {
    const p = parsed[idx];
    if (p.prefix === ' ') {
      // 通常 context 行に marker が付くことは無い、という前提は誤り — 実 git は
      // 「最終行が未変更かつ末尾改行が無い」場合、genuine context 行にも marker を
      // 付ける(reviewer が実証: `printf 'a\nb' > f; ... ; printf 'X\nb' > f; git diff`
      // で ' b' に marker が付く)。この入力自体は正しく処理できる — 理由は「context に
      // 付かないから」ではなく「EOF marker は常に(その時点の)出力の末尾にあり、
      // このガードの違反条件(marker より後ろに同じ側の内容がある)を満たさないから」
      // である。pullIndices=[] のままなので、万一違反すれば(=後ろに何か続けば、
      // 本来ありえないはずだが)引き込む対象が無く、即座にガードで throw する
      // (FYI: diff.suppressBlankEmpty 由来の空文字列 context 行は raw[0] が
      // undefined になり isOld/isNew が両方 false になるため現状は到達しないが、
      // marker は常に真の EOF にあり context 行は元の順序のまま出力されるため
      // 構造的に安全 — 潜在的な脆さとして記録しておく)。
      pushLine(p.raw, p.marker, p.hunkIndex, []);
      oldLines++;
      newLines++;
      idx++;
      continue;
    }

    // 変更ブロック: 連続する '-' をすべて集め、続けて連続する '+' をすべて集める
    // (git diff は常にこの順で出力する。実 git で確認済み — ファイル冒頭コメント参照)。
    const dels: ParsedHunkContentLine[] = [];
    while (idx < parsed.length && parsed[idx].prefix === '-') {
      dels.push(parsed[idx]);
      idx++;
    }
    const adds: ParsedHunkContentLine[] = [];
    while (idx < parsed.length && parsed[idx].prefix === '+') {
      adds.push(parsed[idx]);
      idx++;
    }

    const k = Math.min(dels.length, adds.length);
    for (let i = 0; i < k; i++) {
      const d = dels[i];
      const a = adds[i];
      const dSelected = selected.has(d.hunkIndex);
      const aSelected = selected.has(a.hunkIndex);
      const pairPull = [d.hunkIndex, a.hunkIndex];

      if (dSelected) {
        pushLine(d.raw, d.marker, d.hunkIndex, pairPull);
        oldLines++;
      } else if (direction === 'forward') {
        pushLine(' ' + d.raw.slice(1), d.marker, d.hunkIndex, pairPull);
        oldLines++;
        newLines++;
      } // reverse かつ未選択: 丸ごと削除(何も出力しない)

      if (aSelected) {
        pushLine(a.raw, a.marker, a.hunkIndex, pairPull);
        newLines++;
      } else if (direction === 'reverse') {
        pushLine(' ' + a.raw.slice(1), a.marker, a.hunkIndex, pairPull);
        oldLines++;
        newLines++;
      } // forward かつ未選択: 丸ごと削除(何も出力しない)
    }
    // 削除・追加の個数が異なる場合の残り(ペアになれなかった側)。元の配列内での
    // 相対順序(D[]/A[] それぞれの末尾側)を保ったまま、通常の単独行ルールで処理する。
    // ペア相手が無いため、引き込み対象は自分自身の hunkIndex のみ。
    for (let i = k; i < dels.length; i++) {
      const d = dels[i];
      if (selected.has(d.hunkIndex)) {
        pushLine(d.raw, d.marker, d.hunkIndex, [d.hunkIndex]);
        oldLines++;
      } else if (direction === 'forward') {
        pushLine(' ' + d.raw.slice(1), d.marker, d.hunkIndex, [d.hunkIndex]);
        oldLines++;
        newLines++;
      }
    }
    for (let i = k; i < adds.length; i++) {
      const a = adds[i];
      if (selected.has(a.hunkIndex)) {
        pushLine(a.raw, a.marker, a.hunkIndex, [a.hunkIndex]);
        newLines++;
      } else if (direction === 'reverse') {
        pushLine(' ' + a.raw.slice(1), a.marker, a.hunkIndex, [a.hunkIndex]);
        oldLines++;
        newLines++;
      }
    }
  }

  // EOF marker の不変条件チェック(must-fix ガード。上記コメントの方針 1)。
  for (const ev of markerEvents) {
    for (let j = ev.contentPos + 2; j < outLines.length; j++) {
      const line = outLines[j];
      if (line.startsWith('\\')) continue; // 他の marker 行自体は内容ではない
      const prefix = line[0];
      const isOld = prefix === ' ' || prefix === '-';
      const isNew = prefix === ' ' || prefix === '+';
      if ((ev.claimsOld && isOld) || (ev.claimsNew && isNew)) {
        // 違反した marker 行自身の出力プレフィックスで解消方法を分ける(方針 2)。
        // ' '(context 化された行): 引き込み(2-a)。'-'/'+' (維持された変更行、
        // context 化されていない): その行自身の marker を破棄(2-b)。
        const ownPrefix = outLines[ev.contentPos][0];
        if (ownPrefix === '-' || ownPrefix === '+') {
          return { ok: false, action: 'suppress', hunkIndex: ev.ownerHunkIndex };
        }
        return { ok: false, action: 'pullIn', pullIndices: ev.pullIndices };
      }
    }
  }

  return { ok: true, lines: outLines, oldLines, newLines };
}

function transformHunkLines(
  hunk: DiffHunk,
  lineSel: number[],
  direction: ApplyDirection,
  /** このハンクが、選択元の hunks 配列の中で実際に最後のハンクかどうか。末尾番人
   * (空文字列)の判定に使う(下記参照。不具合5の修正)。 */
  isLastHunk: boolean,
): { lines: string[]; oldLines: number; newLines: number } {
  // 末尾番人は「値が空文字列」ではなく「実ファイル最後のハンクの最後の要素という位置」
  // で判定する(不具合5の修正)。`git config diff.suppressBlankEmpty true` の環境では
  // 空行の context 行が `' '` ではなく空文字列そのもので出力される(実 git で確認済み)。
  // 値だけで判定すると、ハンク中央や非最終ハンクの末尾に現れる空行 context まで
  // 末尾番人と誤認して行数がずれ、内部不整合なパッチを組んでしまう。
  let lines = hunk.lines;
  let sentinel: string | null = null;
  if (isLastHunk && lines.length > 0 && lines[lines.length - 1] === '') {
    sentinel = '';
    lines = lines.slice(0, -1);
  }

  // 内容行を marker 付きで構造化する。marker はその内容行に「くっついて」動く
  // (元の hunk.lines 上で直後にあった `\ No newline...` 行は、並び替え後もその内容行の
  // 直後に出力される)。
  const parsed: ParsedHunkContentLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('\\')) {
      if (parsed.length === 0) throw new Error(`不明な diff 行です: ${JSON.stringify(line)}`);
      parsed[parsed.length - 1].marker = line;
      continue;
    }
    if (line === '') {
      // diff.suppressBlankEmpty=true の空行 context 行(不具合5)。末尾番人はここに
      // 来る前に上で切り離し済みのため、ここに現れる空文字列は常に内容(空行)として
      // context 扱いする。
      parsed.push({ hunkIndex: i, prefix: ' ', raw: '', marker: null });
      continue;
    }
    const prefix = line[0];
    if (prefix !== ' ' && prefix !== '-' && prefix !== '+') {
      throw new Error(`不明な diff 行です: ${JSON.stringify(line)}`);
    }
    parsed.push({ hunkIndex: i, prefix: prefix as ' ' | '-' | '+', raw: line, marker: null });
  }

  // EOF marker 絡みの不変条件違反は、状況に応じて「引き込み」(2-a)か「marker 破棄」
  // (2-b)のいずれかで大半が解消する(上記コメントの方針 2)。1 回で解消しなければ
  // 実効選択・抑止集合を都度更新してもう一度試す。両集合とも単調増加のため
  // (parsed.length * 2 + 1) 回で必ず「これ以上変わらない(=解消不能)」に到達し、
  // そこでフェイルクローズドに throw する(方針 1 のガード)。
  const effectiveSelected = new Set(lineSel);
  const suppressedMarkers = new Set<number>();
  const maxAttempts = parsed.length * 2 + 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = buildHunkOutputOnce(parsed, effectiveSelected, direction, suppressedMarkers);
    if (result.ok) {
      const outLines = sentinel !== null ? [...result.lines, sentinel] : result.lines;
      // 選択の結果、変更行が 1 つも残らないハンク(context 行のみ)は git apply が
      // "corrupt patch" として拒否する(実 git で確認済み)。呼び出し側の意図しない
      // no-op 適用を防ぐためここで止める(checkApplyHunksRequest がこの状況を事前に
      // 400 として弾くが、この関数を直接呼ぶ場合の安全網として残す)。
      if (!outLines.some((l) => l.startsWith('+') || l.startsWith('-'))) {
        throw new Error('選択の結果、変更が残らないハンクになりました(コンテキスト行のみの選択はできません)');
      }
      return { lines: outLines, oldLines: result.oldLines, newLines: result.newLines };
    }
    if (result.action === 'suppress') {
      if (suppressedMarkers.has(result.hunkIndex)) {
        // 既に抑止済みなのにまだ違反する = これ以上打つ手が無い(方針 1 のガード)。
        throw new Error(
          '末尾に改行の無い行の選択が不整合です(その変更に関連する行もまとめて選択してください)',
        );
      }
      suppressedMarkers.add(result.hunkIndex);
      continue;
    }
    const sizeBefore = effectiveSelected.size;
    for (const i of result.pullIndices) effectiveSelected.add(i);
    if (effectiveSelected.size === sizeBefore) {
      // 引き込んでも増えない = これ以上打つ手が無い。黙って壊れたバイトを返すより
      // ここで止める方が安全(must-fix 方針 1)。
      throw new Error(
        '末尾に改行の無い行の選択が不整合です(その変更に関連する行もまとめて選択してください)',
      );
    }
  }
  throw new Error(
    '末尾に改行の無い行の選択が不整合です(その変更に関連する行もまとめて選択してください)',
  );
}

/**
 * 選択ハンクについて、ハンクごとに行単位の部分選択を適用してパッチを組み立てる。
 * `buildPartialPatch` の上位互換: `lineSelections` を省略する、または全要素を
 * null/undefined にすると `buildPartialPatch(header, hunks, selected)` とバイト単位で
 * 同一の出力になる(ヘッダーも内容も一切再計算せず元のハンクをそのまま使うため。
 * 回帰テストで担保)。
 *
 * `lineSelections[i]` が非 null の配列のハンクだけ、`hunks[selected[i]].lines` への
 * インデックス配列として一部行を選択する。行単位選択ではハンクが自己完結でなくなるため
 * `@@` 行の行数を再計算する(ファイル先頭のトップコメント参照)。
 *
 * `@@` 行の 4 つの数値のうち、適用方向の実測アンカー側(forward の oldStart/oldLines、
 * reverse の newStart/newLines)は選択に関わらず常に元のハンクの値のまま変わらない
 * (pre-image の物理的な行位置は他ハンクの選択状況に左右されないため)。もう一方
 * (forward の newStart、reverse の oldStart)は同一パッチ内で先行する選択ハンクの
 * 増減分だけずれ得るため、累積デルタで再計算する(全行選択のハンクはヘッダーを
 * 書き換えないため、その寄与分は元ヘッダーの行数をそのまま使う)。
 * 実 git はこのずれを多少許容する(fuzzy match)ことを確認済みだが、内部整合の
 * 取れたパッチにしておくのが安全側のため常に再計算する。
 */
export function buildPartialPatchLines(
  header: string,
  hunks: DiffHunk[],
  selected: number[],
  lineSelections: (number[] | null)[] | undefined,
  direction: ApplyDirection,
): string {
  if (selected.length === 0) {
    throw new Error('ハンクが選択されていません');
  }
  for (const idx of selected) {
    if (idx < 0 || idx >= hunks.length || !Number.isInteger(idx)) {
      throw new Error(`不正なハンクインデックスです: ${idx}`);
    }
  }
  if (lineSelections !== undefined && lineSelections.length !== selected.length) {
    throw new Error('lines は hunks と同じ長さの配列が必要です');
  }

  const parts: string[] = [];
  if (header !== '') parts.push(header);

  let cumulativeOffset = 0;

  for (let i = 0; i < selected.length; i++) {
    const hunk = hunks[selected[i]];
    const lineSel = lineSelections ? lineSelections[i] : null;
    const parsed = parseHunkHeader(hunk.header);

    if (lineSel === null || lineSel === undefined) {
      // 全行選択: バイト単位不変のためヘッダーも内容も一切書き換えず元のまま使う。
      parts.push([hunk.header, ...hunk.lines].join('\n'));
      cumulativeOffset += direction === 'forward' ? parsed.newLines - parsed.oldLines : parsed.oldLines - parsed.newLines;
      continue;
    }

    if (lineSel.length === 0) {
      throw new Error(`ハンク ${selected[i]} の行選択が空です`);
    }
    for (const li of lineSel) {
      if (!Number.isInteger(li) || li < 0 || li >= hunk.lines.length) {
        throw new Error(`不正な行インデックスです: ${li}`);
      }
    }

    // 末尾番人の判定(不具合5)に使う「このハンクは選択元 hunks 配列の実際の最後の
    // ハンクか」。selected[i](hunks 配列そのものへの添字)で判定する — 部分選択された
    // 側の `selected` 配列の末尾かどうかではなく、常に元のハンク構成における位置。
    const isLastHunk = selected[i] === hunks.length - 1;
    const transformed = transformHunkLines(hunk, lineSel, direction, isLastHunk);
    const newHeader =
      direction === 'forward'
        ? formatHunkHeader(parsed.oldStart, transformed.oldLines, parsed.oldStart + cumulativeOffset, transformed.newLines, parsed.trailing)
        : formatHunkHeader(parsed.newStart + cumulativeOffset, transformed.oldLines, parsed.newStart, transformed.newLines, parsed.trailing);

    parts.push([newHeader, ...transformed.lines].join('\n'));
    cumulativeOffset += direction === 'forward' ? transformed.newLines - transformed.oldLines : transformed.oldLines - transformed.newLines;
  }

  let result = parts.join('\n');
  const lastSelectedIdx = selected[selected.length - 1];
  if (lastSelectedIdx !== hunks.length - 1) {
    result += '\n';
  }
  return result;
}

/** POST /api/git/apply-hunks が楽観ロック不一致で返す固定文言。client/src/diffHunk.ts の
 * HUNK_CONFLICT_MESSAGE と手動同期(共有型機構が無いため)。 */
export const HUNK_CONFLICT_MESSAGE = '差分が変化しました。再読み込みしてください';

/**
 * ハンク 1 個分の楽観ロック用ハッシュ(不具合2/3の修正)。ヘッダー+全内容行を
 * latin1(バイト保存)で連結した生バイト列から計算する — utf8 デコードは非可逆なため、
 * 非 UTF-8 ファイル(Shift_JIS 等)では異なるバイト列が同じ utf8 文字列に化けることがあり
 * (例: SJIS の「あ」「い」がどちらも U+FFFD に潰れる)、utf8 文字列同士の比較では
 * 楽観ロックを素通りさせてしまう(reviewer が実測)。生バイトのハッシュ化ならエンコーディングに
 * 関わらず安全。GET /api/git/diff-hunks(要求時点)と apply-hunks の検証(適用時点)の
 * 双方でこの関数を通した値を突き合わせる。
 */
export function hashHunk(hunk: DiffHunk): string {
  const bytes = Buffer.from([hunk.header, ...hunk.lines].join('\n'), 'latin1');
  return createHash('sha256').update(bytes).digest('hex');
}

/** POST /api/git/apply-hunks のうち `hunks`(空でない number[])自体の検証を終えた後に
 * 呼ぶ、残り全ての検証(lines の型・範囲・「変更が残るか」・楽観ロックのハッシュ照合・
 * 409/400 判定)への入力。 */
export interface ApplyHunksCheckInput {
  /** 検証済みの選択ハンク添字配列(呼び出し側=ルートで「空でない number[]」を確認済み)。 */
  selected: number[];
  /** リクエスト body の `lines`(未検証)。 */
  rawLines: unknown;
  /** リクエスト body の `expectedHunkCount`(未検証)。 */
  expectedHunkCount: unknown;
  /** リクエスト body の `expectedHunkHashes`(未検証)。hunks と同順・同長で、各要素は
   * GET /api/git/diff-hunks が返した対応ハンクの hunkHashes[i] をそのまま渡したもの。
   * 行選択の有無にかかわらず無条件で検証する(不具合3の修正: 以前はハンク単位選択
   * (lines[i] === null)の経路にだけ楽観ロックの穴が残っていた)。 */
  expectedHunkHashes: unknown;
  /** 適用時点でサーバーが取り直した権威 diff のハンク配列(latin1 パース)。 */
  authoritativeHunks: DiffHunk[];
}

export type ApplyHunksCheckResult =
  | { ok: true; lineSelections: (number[] | null)[] | undefined }
  | { ok: false; status: 400; error: string }
  | { ok: false; status: 409; error: string };

/**
 * POST /api/git/apply-hunks の検証ブロックを純関数として切り出したもの(reviewer 指摘:
 * server/index.ts はモジュールスコープに副作用があり supertest 等のルートテストを
 * 書けないため、検証ロジックだけをここに抽出して vitest で直接テストする — これが
 * 不具合2/3 の恒久回帰テストになる)。
 */
export function checkApplyHunksRequest(input: ApplyHunksCheckInput): ApplyHunksCheckResult {
  const { selected, rawLines, expectedHunkCount, expectedHunkHashes, authoritativeHunks } = input;

  // 行単位ステージ用。hunks と同順・同長の並行配列。null/省略はそのハンク全行選択
  // (従来動作)。typeof チェックを先に置く(`String(x ?? '')` 型の検証は配列 body
  // `["a","b"]` を `"a,b"` に化かして素通しさせる教訓 — Phase 6 由来)。
  let lineSelections: (number[] | null)[] | undefined;
  if (rawLines !== undefined && rawLines !== null) {
    if (!Array.isArray(rawLines) || rawLines.length !== selected.length) {
      return { ok: false, status: 400, error: 'lines は hunks と同じ長さの配列が必要です' };
    }
    for (const entry of rawLines) {
      if (entry === null) continue;
      if (!Array.isArray(entry) || entry.length === 0 || !entry.every((n) => typeof n === 'number' && Number.isInteger(n))) {
        return { ok: false, status: 400, error: 'lines の各要素は空でない number[] または null が必要です' };
      }
    }
    lineSelections = rawLines as (number[] | null)[];
  }

  // ハンク数の不一致は早期に弾く(並行編集でハンク構成そのものが変わった粗い検知)。
  const hunkCount = Number(expectedHunkCount);
  if (authoritativeHunks.length === 0 || authoritativeHunks.length !== hunkCount) {
    return { ok: false, status: 409, error: HUNK_CONFLICT_MESSAGE };
  }

  // フェイルクローズド: selected と同順・同長の string[] でなければ検証不能なので即 409
  // (expectedHunkCount が欠落 → NaN → 上の hunkCount 比較で 409 になるのと同じ精神)。
  if (
    !Array.isArray(expectedHunkHashes) ||
    expectedHunkHashes.length !== selected.length ||
    !expectedHunkHashes.every((h): h is string => typeof h === 'string')
  ) {
    return { ok: false, status: 409, error: HUNK_CONFLICT_MESSAGE };
  }

  // ハッシュ照合は行選択の有無にかかわらず無条件に行う(不具合3の修正)。
  for (let i = 0; i < selected.length; i++) {
    const hunk = authoritativeHunks[selected[i]];
    if (!hunk || hashHunk(hunk) !== expectedHunkHashes[i]) {
      return { ok: false, status: 409, error: HUNK_CONFLICT_MESSAGE };
    }
  }

  // lines の行インデックス範囲検証 + 「選択の結果、変更が残らない」ケースの事前検知
  // (FYI-7: 以前はこのケースが transformHunkLines の奥まで進んでから plain Error を
  // 投げ、ルートの catch-all で 500 になっていた。ここで先回りして 400 にする。
  // 選択された行に '+'/'-' が 1 つも無ければ、後段の変換でどうやっても変更が残らない
  // ことが確定するため、ここで判定できる)。
  if (lineSelections) {
    for (let i = 0; i < selected.length; i++) {
      const sel = lineSelections[i];
      if (sel === null || sel === undefined) continue;
      const hunk = authoritativeHunks[selected[i]];
      const lineCount = hunk.lines.length;
      if (!sel.every((li) => li >= 0 && li < lineCount)) {
        return { ok: false, status: 400, error: `不正な行インデックスです(ハンク ${selected[i]})` };
      }
      const hasChangeLine = sel.some((li) => {
        const line = hunk.lines[li];
        return line.startsWith('+') || line.startsWith('-');
      });
      if (!hasChangeLine) {
        return {
          ok: false,
          status: 400,
          error: `選択した行に変更(追加/削除)が含まれていません(ハンク ${selected[i]})`,
        };
      }
    }
  }

  return { ok: true, lineSelections };
}
