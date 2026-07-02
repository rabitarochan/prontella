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

export const useDeck = create<DeckState>((set) => ({
  repos: [],
  loaded: false,
  selected: null,
  error: null,
  refresh: async () => {
    try {
      const repos = await api.repos();
      set({ repos, loaded: true, error: null });
    } catch (e) {
      // repos は渡さず直前の一覧を保持し、エラーだけ表示する
      // (サーバー一時エラーで UI が即座に空にならないようにする)
      set({ error: e instanceof Error ? e.message : String(e), loaded: true });
    }
  },
  select: (selected) => set({ selected }),
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
