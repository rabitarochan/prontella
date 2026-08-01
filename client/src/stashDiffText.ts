/**
 * StashDiffPane 用の純関数。`git stash show -p` が返す unified diff テキストを
 * 行ごとに分類し、CSS クラスだけを決める(表示専用の簡易ハイライトであり、
 * DiffHunkStrip/diffPatch.ts のような適用用の権威パースではない)。
 */

export type DiffLineKind = 'meta' | 'hunk' | 'add' | 'del' | 'context';

// server/files.ts の MAX_FILE_SIZE (2MB) と同じ閾値 (client/src/editorState.ts の
// MAX_DRAFT_TEXT_LENGTH も同様に踏襲)。stash diff はサーバー側にサイズ上限が無く
// (server/git.ts の stashShow は runGit の出力をそのまま返す)、StashDiffPane が
// `text.split('\n')` で 1 行 1 div に展開するため、無制限だとタブを開いただけで
// 巨大な DOM ノード数を作ってしまう。ここで行境界を保ったまま切り詰める。
export const MAX_STASH_DIFF_TEXT_LENGTH = 2_000_000;

/**
 * stash diff テキストを MAX_STASH_DIFF_TEXT_LENGTH で切り詰める。行の途中で切らないよう、
 * 上限以下の直近の改行位置まで戻る (見つからなければ上限位置でそのまま切る)。
 * `cut === 0` (先頭が改行で、上限内に他の改行が無い) も `slice(0, 0)` で空表示になって
 * しまう退化ケースなので、`-1` と同じく上限位置での固定切りにフォールバックする。
 */
export function truncateStashDiffText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_STASH_DIFF_TEXT_LENGTH) return { text, truncated: false };
  const cut = text.lastIndexOf('\n', MAX_STASH_DIFF_TEXT_LENGTH);
  return { text: text.slice(0, cut <= 0 ? MAX_STASH_DIFF_TEXT_LENGTH : cut), truncated: true };
}

/**
 * ファイルヘッダー (`diff --git`/`index`/`---`/`+++`) を先に判定してから `+`/`-` 始まりを
 * 見る。順序が重要 — 実際のコード行が `+++`/`---` で始まる場合 (例: `+++x` という追加行) との
 * 曖昧さは、git が生成するヘッダー行が必ず `--- `/`+++ ` (直後に半角スペース) である一方、
 * 追加/削除行のプレフィックスは内容が続く (`+++x` のように直後にスペースが無いことが多い) 点で
 * 大半のケースを正しく分類できるが、完全ではない (表示専用の簡易分類であることの注記)。
 */
export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith('diff --git ') || line.startsWith('index ') || line.startsWith('\\ ')) return 'meta';
  if (line.startsWith('--- ') || line.startsWith('+++ ')) return 'meta';
  if (line.startsWith('@@ ')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'context';
}
