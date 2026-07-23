/**
 * StashDiffPane 用の純関数。`git stash show -p` が返す unified diff テキストを
 * 行ごとに分類し、CSS クラスだけを決める(表示専用の簡易ハイライトであり、
 * DiffHunkStrip/diffPatch.ts のような適用用の権威パースではない)。
 */

export type DiffLineKind = 'meta' | 'hunk' | 'add' | 'del' | 'context';

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
