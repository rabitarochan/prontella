import { create } from 'zustand';
import { api } from './api';
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
  refresh: () => Promise<void>;
  select: (selection: Selection | null) => void;
  setError: (error: string | null) => void;
}

const SELECTED_STORAGE_KEY = 'claude-deck.selected';

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
// 4 秒ごとに毎回再レンダーされてしまうため、内容が変わらないポーリングでは
// 再レンダーの引き金を作らないようにする。
let lastReposJson: string | null = null;

export const useDeck = create<DeckState>((set, get) => ({
  repos: [],
  loaded: false,
  selected: null,
  error: null,
  refresh: async () => {
    try {
      const repos = await api.repos();
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
      // repos は渡さず直前の一覧を保持し、エラーだけ表示する
      // (サーバー一時エラーで UI が即座に空にならないようにする)
      // ここでは restoreAttempted を立てない — 次回成功時に復元を再挑戦させる。
      set({ error: e instanceof Error ? e.message : String(e), loaded: true });
    }
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
}));

export function findSelection(repos: Repo[], selected: Selection | null) {
  if (!selected) return null;
  const repo = repos.find((r) => r.id === selected.repoId);
  if (!repo) return null;
  const worktree = repo.worktrees.find((w) => w.path === selected.worktreePath);
  if (!worktree) return null;
  return { repo, worktree };
}
