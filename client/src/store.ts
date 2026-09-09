import { create } from 'zustand';
import { api } from './api';
import { applyRepoMeta, isActive } from './repoSections';
import type { Repo } from './types';

export interface Selection {
  repoId: string;
  worktreePath: string;
}

interface DeckState {
  repos: Repo[];
  loaded: boolean;
  selected: Selection | null;
  error: string | null;
  /**
   * repos を取り直す。
   *
   * reuseInFlight: 進行中の取得があればそれに相乗りする。**ポーラーだけが渡してよい**。
   * 変異 (コミット・stage・worktree 追加など) の直後の refresh が相乗りすると、
   * 「変異前に始まった取得」の結果を受け取ってしまい、コミット直後に古い状態を
   * 表示する。既定 (false) は常に新規取得。
   */
  refresh: (opts?: { reuseInFlight?: boolean }) => Promise<void>;
  select: (selection: Selection | null) => void;
  setError: (error: string | null) => void;
  /** 楽観更新する。失敗したら退避しておいた直前の配列に戻し setError する。 */
  reorderRepos: (order: string[]) => Promise<void>;
  /** 楽観更新しない。成否を呼び出し側に返す(選択中 repo の扱いをサイドバー側で分岐させるため)。 */
  setRepoPinned: (id: string, pinned: boolean) => Promise<boolean>;
  /** 楽観更新しない。成否を呼び出し側に返す(理由は setRepoPinned と同じ)。 */
  setRepoArchived: (id: string, archived: boolean) => Promise<boolean>;
}

const SELECTED_STORAGE_KEY = 'prontella.selected';

function isSelectionLike(value: unknown): value is Selection {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Selection).repoId === 'string' &&
    typeof (value as Selection).worktreePath === 'string'
  );
}

/**
 * 初回ロード成功時のみ呼ばれる。localStorage の保存値を取得済み repos に対して
 * 検証し、有効なら復元後の Selection を、無効/破損/未保存なら null を返す。
 * 検証に失敗した場合は保存値を削除する(次回以降は Deck 一覧のまま静かに動く)。
 */
function restoreSelection(repos: Repo[]): Selection | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(SELECTED_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try {
      localStorage.removeItem(SELECTED_STORAGE_KEY);
    } catch {
      // storage unavailable — これ以上できることはない
    }
    return null;
  }

  if (parsed === null) return null; // 明示的に Deck 一覧に戻った状態を保存したもの

  if (!isSelectionLike(parsed) || !findSelection(repos, parsed)) {
    try {
      localStorage.removeItem(SELECTED_STORAGE_KEY);
    } catch {
      // storage unavailable — これ以上できることはない
    }
    return null;
  }

  return parsed;
}

// 復元を「試みたか」を loaded とは独立に管理する。loaded は catch 側でも true に
// なる(エラー表示制御のため)ので、これを復元ゲートに使うと初回 repos 取得が
// 一時的に失敗しただけで以後ずっと復元が試行されなくなる。復元は成功パスで実際に
// 試みたときにだけ true にし、失敗パスでは立てない(→ 次の成功時に再挑戦できる)。
let restoreAttempted = false;

// 直近に set() した repos の内容 (JSON化) を覚えておき、次回取得分と一致するなら
// set() 自体を呼ばない。useDeck をセレクターなしで購読している App 以下のツリーは
// ポーリングのたびに毎回再レンダーされてしまうため、内容が変わらないポーリングでは
// 再レンダーの引き金を作らないようにする。
let lastReposJson: string | null = null;

// 進行中の refresh()。reuseInFlight を渡した呼び出し (= ポーラー) だけがここに相乗りする。
// 変異直後の refresh は相乗りさせない — 詳細は DeckState.refresh のコメント。
let inflightRefresh: Promise<void> | null = null;

// repos 配列を変更する操作(並び替え/ピン留め/アーカイブ/追加/削除)の mutation epoch。
// ポーリング refresh() が変異結果を踏み消すのを防ぐ (詳細は各関数のコメント参照)。
let reposEpoch = 0;

/**
 * repos を変更する操作の開始時に呼ぶ。epoch を進めて、進行中の refresh() が
 * このタイミングより後に古いレスポンスを適用しようとするのを無効化する。
 * lastReposJson を null にする理由: 変異後のローカル状態は素の GET /api/repos の
 * JSON を再現できないため、次に受理したレスポンスを必ず set() に通してサーバー
 * 真理へ再同期させる。
 */
export function beginRepoMutation(): number {
  reposEpoch += 1;
  lastReposJson = null;
  return reposEpoch;
}

/**
 * 変異のレスポンス適用直前に呼ぶ。開始時の epoch と一致していれば(=自分より後に
 * 別の変異が始まっていなければ)epoch をさらに進めて true を返す。一致しなければ
 * 自分は割り込まれた古いレスポンスなので何もせず false を返す(呼び出し側は set() しない)。
 *
 * 完了時にも epoch を進めるのは、「変異開始→ポーリング開始→変異完了→ポーリング完了」の
 * 順で両者の捕捉 epoch が一致してしまい、ポーリングの古いレスポンスが変異結果を
 * 踏み消す事故を防ぐため(開始時の 1 回だけでは防げない)。
 */
function commitRepoMutation(epoch: number): boolean {
  if (epoch !== reposEpoch) return false;
  reposEpoch += 1;
  return true;
}

/**
 * 楽観更新用: order (id の完全な平坦列) に沿って repos を並べ替える。フラグ
 * (pinned/archived) は変更しない。order に無い id は防御的に元の相対順で末尾に残す
 * (通常は起こらない — moveWithinSection/moveByOffset は repos と同じ id 集合の順列を返す)。
 */
function reorderLocally(repos: Repo[], order: string[]): Repo[] {
  const byId = new Map(repos.map((r) => [r.id, r] as const));
  const seen = new Set<string>();
  const result: Repo[] = [];
  for (const id of order) {
    const repo = byId.get(id);
    if (!repo || seen.has(id)) continue;
    seen.add(id);
    result.push(repo);
  }
  for (const repo of repos) {
    if (!seen.has(repo.id)) result.push(repo);
  }
  return result;
}

export const useDeck = create<DeckState>((set, get) => ({
  repos: [],
  loaded: false,
  selected: null,
  error: null,
  refresh: async (opts) => {
    // 進行中の取得への相乗りは opt-in。ポーラー以外 (変異直後の refresh) が
    // 相乗りすると、変異前に始まった取得の結果を受け取って古い状態を表示する。
    if (opts?.reuseInFlight === true && inflightRefresh !== null) return inflightRefresh;
    const run = (async () => {
      const epoch = reposEpoch;
      try {
        const repos = await api.repos();
        if (epoch !== reposEpoch) return; // 別の変異に割り込まれた古いレスポンス
        const reposJson = JSON.stringify(repos);
        const current = get();
        // 内容が前回と同一で、かつ既に loaded/エラー解消済み/復元試行済みなら
        // 何もすることがない (set() で新しい repos 配列を作ると参照が変わり、
        // useDeck() をセレクターなしで購読している側が無条件で再レンダーされる)。
        // error からの回復 (error !== null) や初回ロードはこの条件に当たらないため
        // 従来どおり set() を通る。
        if (reposJson === lastReposJson && current.loaded && current.error === null && restoreAttempted) {
          return;
        }
        lastReposJson = reposJson;
        set((state) => {
          if (!restoreAttempted && state.selected === null) {
            restoreAttempted = true;
            return { repos, loaded: true, error: null, selected: restoreSelection(repos) };
          }
          return { repos, loaded: true, error: null };
        });
      } catch (e) {
        if (epoch !== reposEpoch) return; // 別の変異に割り込まれた古いレスポンス
        // repos は渡さず直前の一覧を保持し、エラーだけ表示する
        // (サーバー一時エラーで UI が即座に空にならないようにする)
        // ここでは restoreAttempted を立てない — 次回成功時に復元を再挑戦させる。
        set({ error: e instanceof Error ? e.message : String(e), loaded: true });
      }
    })();
    // finally() は **新しい Promise を返す**。ここで run と比較すると永久に一致せず、
    // inflightRefresh が null に戻らないままポーリングが全部相乗りして止まる
    // (実ブラウザーで踏んだ: 45 秒で /api/repos が 1 回しか飛ばなかった)。
    // 比較対象は「自分が格納したのと同じ Promise」でなければならない。
    const tracked: Promise<void> = run.finally(() => {
      if (inflightRefresh === tracked) inflightRefresh = null;
    });
    inflightRefresh = tracked;
    return tracked;
  },
  select: (selected) => {
    try {
      // null も保存する(明示的に Deck 一覧に戻った状態をリロード後も再現するため)
      localStorage.setItem(SELECTED_STORAGE_KEY, JSON.stringify(selected));
    } catch {
      // storage unavailable — 選択状態はメモリ上でのみ有効になる
    }
    set({ selected });
  },
  setError: (error) => set({ error }),
  reorderRepos: async (order) => {
    const previous = get().repos;
    const epoch = beginRepoMutation();
    set({ repos: reorderLocally(previous, order) });
    try {
      const { repos: meta } = await api.reorderRepos(order);
      if (!commitRepoMutation(epoch)) return;
      const { repos: applied, needsRefresh } = applyRepoMeta(get().repos, meta);
      set({ repos: applied });
      if (needsRefresh) await get().refresh();
    } catch (e) {
      if (!commitRepoMutation(epoch)) return;
      set({ repos: previous, error: e instanceof Error ? e.message : String(e) });
    }
  },
  setRepoPinned: async (id, pinned) => {
    const epoch = beginRepoMutation();
    try {
      const { repos: meta } = await api.setRepoFlags(id, { pinned });
      if (!commitRepoMutation(epoch)) return false;
      const { repos: applied, needsRefresh } = applyRepoMeta(get().repos, meta);
      set({ repos: applied });
      if (needsRefresh) await get().refresh();
      return true;
    } catch (e) {
      if (!commitRepoMutation(epoch)) return false;
      set({ error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },
  setRepoArchived: async (id, archived) => {
    const epoch = beginRepoMutation();
    try {
      const { repos: meta } = await api.setRepoFlags(id, { archived });
      if (!commitRepoMutation(epoch)) return false;
      const { repos: applied, needsRefresh } = applyRepoMeta(get().repos, meta);
      set({ repos: applied });
      if (needsRefresh) await get().refresh();
      return true;
    } catch (e) {
      if (!commitRepoMutation(epoch)) return false;
      set({ error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },
}));

export function findSelection(repos: Repo[], selected: Selection | null) {
  if (!selected) return null;
  const repo = repos.find((r) => r.id === selected.repoId);
  if (!repo || !isActive(repo)) return null;
  const worktree = repo.worktrees.find((w) => w.path === selected.worktreePath);
  if (!worktree) return null;
  return { repo, worktree };
}
