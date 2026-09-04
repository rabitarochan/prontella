/**
 * markdown-it-task-lists は型定義を同梱していない (package.json に "types" フィールド
 * 無し、実体は素の JS)。ここで最小限の ambient 宣言を用意する。
 * 実装 (node_modules/markdown-it-task-lists/index.js) は
 * `module.exports = function(md, options) { ... }` というシグネチャで export している。
 */
declare module 'markdown-it-task-lists' {
  // markdown-it 15 は型定義を自前で同梱するようになり、@types/markdown-it にあった
  // MarkdownIt.PluginWithOptions<T> は無くなったため、シグネチャを直接書く。
  import type { MarkdownIt } from 'markdown-it';

  interface TaskListsOptions {
    /** チェックボックスを disabled にせず有効化する (クリック可能にする)。既定は無効。 */
    enabled?: boolean;
    /** タスク項目のテキストを <label> でラップする。 */
    label?: boolean;
    /** label 使用時、チェックボックスの後にラベルテキストを置く。 */
    labelAfter?: boolean;
  }

  const taskLists: (md: MarkdownIt, options?: TaskListsOptions) => void;
  export default taskLists;
}
