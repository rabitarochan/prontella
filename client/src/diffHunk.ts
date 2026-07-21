import type { DiffHunk } from './types';

/**
 * ハンク単位ステージ UI (DiffHunkStrip) 用の純関数群。
 * サーバー側 (server/diffPatch.ts) が組み立てる DiffHunk を UI 表示用に解釈するだけで、
 * git 操作は一切行わない。
 */

export interface HunkPosition {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

// unified diff のハンクヘッダー: `@@ -oldStart,oldLines +newStart,newLines @@ ...`
// `,oldLines`/`,newLines` は該当範囲が 1 行のとき省略される (git の unified diff 仕様)。
const HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseHunkHeader(header: string): HunkPosition | null {
  const m = HEADER_RE.exec(header);
  if (!m) return null;
  return {
    oldStart: Number(m[1]),
    oldLines: m[2] !== undefined ? Number(m[2]) : 1,
    newStart: Number(m[3]),
    newLines: m[4] !== undefined ? Number(m[4]) : 1,
  };
}

/** ハンク内の追加行数・削除行数 (+n / -m 表示用)。`\ No newline at end of file` はどちらにも数えない。 */
export function hunkStats(hunk: DiffHunk): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of hunk.lines) {
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

// server/index.ts の POST /api/git/apply-hunks が 409 のとき返す固定文言と一致させて判定する
// (client/src/api.ts の request() は HTTP ステータスを保持せず Error.message しか返さないため、
// 文言一致で判定するしかない。サーバー側の文言を変える場合はここも合わせて直すこと)。
export const HUNK_CONFLICT_MESSAGE = '差分が変化しました。再読み込みしてください';
