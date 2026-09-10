import { create } from 'zustand';

/**
 * 「この作業ツリーの git の状態 (index / HEAD) が変わった」ことを、パネルをまたいで
 * 伝えるだけの軽量なカウンター。永続化しない (プロセス内の通知経路)。
 *
 * **なぜポーリングではないのか**: ファイルパネルのガター差分の比較基準 (index の内容) が
 * 変わるのは、stage / unstage / commit / ブランチ切替のような**離散的な操作のときだけ**。
 * 変化頻度がポーリング間隔より遥かに低い値をポーリングで配るのは無駄で、逆に
 * 「操作したのに数秒間ガターが古い」というズレも出る (pj-client-ui-state §13 の裏返し)。
 * 書き手は GitTab / DiffHunkStrip / DiffPane、読み手は FilesTab の useGitGutter。
 *
 * キーは作業ツリーのパス。FilesTab の `root` と GitTab の `worktree.path` は同じ値なので、
 * 同じ leaf の別ビューにも、別タイルの同じ worktree にも届く。
 */

interface GitEpochState {
  epochs: Record<string, number>;
  bump: (dir: string) => void;
}

export const useGitEpoch = create<GitEpochState>((set) => ({
  epochs: {},
  bump: (dir) =>
    set((s) => ({ epochs: { ...s.epochs, [dir]: (s.epochs[dir] ?? 0) + 1 } })),
}));

/** React の外 (イベントハンドラー等) から呼ぶための薄いヘルパー。 */
export function bumpGitEpoch(dir: string): void {
  useGitEpoch.getState().bump(dir);
}
