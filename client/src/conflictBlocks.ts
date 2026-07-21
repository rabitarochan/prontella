/**
 * git 競合マーカー (`<<<<<<<` / `|||||||` / `=======` / `>>>>>>>`) のパースと
 * ours/theirs/both 置換ロジック。ConflictResolvePane (Monaco 上の競合解決 UI) 用の
 * 純関数群 — git 操作は一切行わない (diffHunk.ts と同じ位置づけ)。
 */

export interface ConflictBlock {
  /** '<<<<<<<' 行 (0-based, splitLines の行インデックス) */
  startLine: number;
  /** '>>>>>>>' 行 (0-based) */
  endLine: number;
  /** ours 側の内容行範囲 [oursStart, oursEnd) */
  oursStart: number;
  oursEnd: number;
  /** theirs 側の内容行範囲 [theirsStart, theirsEnd) */
  theirsStart: number;
  theirsEnd: number;
  /** '<<<<<<< HEAD' などマーカー直後の文字列 (無ければ空文字) */
  oursLabel: string;
  /** '>>>>>>> feature' などマーカー直後の文字列 */
  theirsLabel: string;
  /** diff3 形式 (共通祖先ブロック `|||||||` 付き) か。ours/theirs の範囲計算からは
   *  常に除外されるが、UI 側で表示を変えたい場合に備えて残す。 */
  hasBase: boolean;
}

export type ConflictResolveKind = 'ours' | 'theirs' | 'both';

const START_RE = /^<{7}(?: (.*))?$/;
const BASE_RE = /^\|{7}(?: (.*))?$/;
const SEP_RE = /^={7}$/;
const END_RE = /^>{7}(?: (.*))?$/;

/**
 * テキストを Monaco の行分割と同じ規則 (\r\n / \r / \n いずれも改行として扱う) で
 * 行配列にする。Monaco の Range/column は改行文字を含まない行内容を前提にするため、
 * エディター側でブロックの置換範囲を計算するときもこの分割結果と対応させること。
 */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/**
 * 競合マーカーをパースする。マーカーの対応が崩れている(開始のみ・区切りや終端が
 * 見つからない・入れ子)場合はそのブロックを無視し、開始行の次の行から探索を続ける —
 * 手動編集で一時的に不整合な状態でも、他の正常なブロックの解決を妨げない。
 */
export function parseConflictBlocks(text: string): ConflictBlock[] {
  const lines = splitLines(text);
  const blocks: ConflictBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const startMatch = START_RE.exec(lines[i]);
    if (!startMatch) {
      i++;
      continue;
    }
    const startLine = i;
    let baseLine = -1;
    let sepLine = -1;
    let endLine = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (START_RE.test(lines[j])) break; // 対応する終端が無いまま次の開始 → 壊れたブロック
      if (baseLine === -1 && sepLine === -1 && BASE_RE.test(lines[j])) {
        baseLine = j;
        continue;
      }
      if (sepLine === -1 && SEP_RE.test(lines[j])) {
        sepLine = j;
        continue;
      }
      if (sepLine !== -1 && END_RE.test(lines[j])) {
        endLine = j;
        break;
      }
    }
    if (sepLine === -1 || endLine === -1) {
      i = startLine + 1; // 壊れたブロックは無視して次の行から再走査
      continue;
    }
    blocks.push({
      startLine,
      endLine,
      oursStart: startLine + 1,
      oursEnd: baseLine !== -1 ? baseLine : sepLine,
      theirsStart: sepLine + 1,
      theirsEnd: endLine,
      oursLabel: startMatch[1] ?? '',
      theirsLabel: END_RE.exec(lines[endLine])?.[1] ?? '',
      hasBase: baseLine !== -1,
    });
    i = endLine + 1;
  }
  return blocks;
}

/** ブロックを kind で解決した結果の行配列 (マーカー行は含まない)。both は ours→theirs の順。 */
export function resolvedBlockLines(
  lines: string[],
  block: ConflictBlock,
  kind: ConflictResolveKind,
): string[] {
  const ours = lines.slice(block.oursStart, block.oursEnd);
  const theirs = lines.slice(block.theirsStart, block.theirsEnd);
  if (kind === 'ours') return ours;
  if (kind === 'theirs') return theirs;
  return [...ours, ...theirs];
}

/**
 * ブロック 1 件を kind で解決した後のテキスト全体を返す純粋版(Monaco を介さない)。
 * ConflictResolvePane 本体は Monaco の pushEditOperations でブロック範囲だけを
 * 置換する(undo 履歴を保つため)が、そのロジックは resolvedBlockLines を直接使う。
 * この関数はテストや将来の非エディター用途向け。
 */
export function applyConflictResolution(
  text: string,
  block: ConflictBlock,
  kind: ConflictResolveKind,
  eol = '\n',
): string {
  const lines = splitLines(text);
  const resolved = resolvedBlockLines(lines, block, kind);
  const next = [...lines.slice(0, block.startLine), ...resolved, ...lines.slice(block.endLine + 1)];
  return next.join(eol);
}
