import type {
  BranchInfo,
  BranchStatus,
  CommitFile,
  DiffPair,
  FileContent,
  LogEntry,
  Repo,
  SearchTextResponse,
  StashEntry,
  StatusFile,
  TerminalSession,
  TreeEntry,
  TreeStatusEntry,
} from './types';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

function post<T>(url: string, body: object): Promise<T> {
  return request<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const q = encodeURIComponent;

export const api = {
  repos: () => request<Repo[]>('/api/repos'),
  addRepo: (path: string) => post<Repo>('/api/repos', { path }),
  removeRepo: (id: string) => request<void>(`/api/repos/${id}`, { method: 'DELETE' }),
  branches: (repoId: string) => request<BranchInfo[]>(`/api/repos/${repoId}/branches`),

  addWorktree: (repoId: string, body: { branch?: string; newBranch?: string; base?: string; path?: string }) =>
    post<{ ok: boolean; path: string }>(`/api/repos/${repoId}/worktrees`, body),
  removeWorktree: (repoId: string, path: string, force: boolean) =>
    request<void>(`/api/repos/${repoId}/worktrees?path=${q(path)}&force=${force ? '1' : '0'}`, {
      method: 'DELETE',
    }),

  log: (dir: string, limit = 100, all = false) =>
    request<LogEntry[]>(`/api/git/log?dir=${q(dir)}&limit=${limit}${all ? '&all=1' : ''}`),
  commitDetail: (dir: string, hash: string) =>
    request<{ text: string }>(`/api/git/commit?dir=${q(dir)}&hash=${q(hash)}`),
  gitStatus: (dir: string) =>
    request<{ branch: BranchStatus; files: StatusFile[]; merging: boolean }>(
      `/api/git/status?dir=${q(dir)}`,
    ),
  diff: (dir: string, opts: { path?: string; staged?: boolean; untracked?: boolean } = {}) => {
    const params = new URLSearchParams({ dir });
    if (opts.path) params.set('path', opts.path);
    if (opts.staged) params.set('staged', '1');
    if (opts.untracked) params.set('untracked', '1');
    return request<{ text: string }>(`/api/git/diff?${params}`);
  },
  diffPair: (
    dir: string,
    path: string,
    scope: 'worktree' | 'staged' | 'commit',
    opts: { hash?: string; origPath?: string } = {},
  ) => {
    const params = new URLSearchParams({ dir, path, scope });
    if (opts.hash) params.set('hash', opts.hash);
    if (opts.origPath) params.set('origPath', opts.origPath);
    return request<DiffPair>(`/api/git/diff-pair?${params}`);
  },
  commitFiles: (dir: string, hash: string) =>
    request<CommitFile[]>(`/api/git/commit-files?dir=${q(dir)}&hash=${q(hash)}`),
  stage: (dir: string, path: string) => post<void>('/api/git/stage', { dir, path }),
  unstage: (dir: string, path: string) => post<void>('/api/git/unstage', { dir, path }),
  commit: (dir: string, message: string, amend = false) =>
    post<{ result: string }>('/api/git/commit', { dir, message, amend }),
  stageAll: (dir: string) => post<void>('/api/git/stage-all', { dir }),
  unstageAll: (dir: string) => post<void>('/api/git/unstage-all', { dir }),
  discard: (dir: string, path: string, untracked: boolean) =>
    post<void>('/api/git/discard', { dir, path, untracked }),
  fetch: (dir: string) => post<void>('/api/git/fetch', { dir }),
  pull: (dir: string) => post<{ result: string }>('/api/git/pull', { dir }),
  push: (dir: string) => post<{ result: string }>('/api/git/push', { dir }),
  switchBranch: (dir: string, branch: string, create = false) =>
    post<void>('/api/git/switch', { dir, branch, create }),
  deleteBranch: (dir: string, branch: string, force = false) =>
    post<void>('/api/git/branch-delete', { dir, branch, force }),
  merge: (dir: string, branch: string) => post<{ result: string }>('/api/git/merge', { dir, branch }),
  mergeAbort: (dir: string) => post<void>('/api/git/merge-abort', { dir }),
  stashList: (dir: string) => request<StashEntry[]>(`/api/git/stash?dir=${q(dir)}`),
  stashPush: (dir: string, message?: string) => post<void>('/api/git/stash', { dir, message }),
  stashApply: (dir: string, ref: string, pop: boolean) =>
    post<void>('/api/git/stash-apply', { dir, ref, pop }),
  stashDrop: (dir: string, ref: string) => post<void>('/api/git/stash-drop', { dir, ref }),

  tree: (root: string, dir = '') => request<TreeEntry[]>(`/api/fs/tree?root=${q(root)}&dir=${q(dir)}`),
  treeStatus: (root: string) => request<TreeStatusEntry[]>(`/api/fs/git-status?root=${q(root)}`),
  file: (root: string, path: string) =>
    request<FileContent>(`/api/fs/file?root=${q(root)}&path=${q(path)}`),
  saveFile: (root: string, path: string, content: string) =>
    request<void>('/api/fs/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root, path, content }),
    }),
  createFile: (root: string, path: string) => post<{ ok: boolean }>('/api/fs/file', { root, path }),
  createFolder: (root: string, path: string) => post<{ ok: boolean }>('/api/fs/dir', { root, path }),

  searchFiles: (root: string) => request<{ files: string[] }>(`/api/search/files?root=${q(root)}`),
  searchText: (
    root: string,
    query: string,
    opts: { regex?: boolean; caseSensitive?: boolean; max?: number } = {},
    signal?: AbortSignal,
  ) => {
    const params = new URLSearchParams({ root, q: query });
    if (opts.regex) params.set('regex', '1');
    if (opts.caseSensitive) params.set('case', '1');
    if (opts.max) params.set('max', String(opts.max));
    return request<SearchTextResponse>(`/api/search/text?${params}`, { signal });
  },

  terminals: (cwd?: string) =>
    request<TerminalSession[]>(`/api/terminals${cwd ? `?cwd=${q(cwd)}` : ''}`),
  createTerminal: (cwd: string, run?: string) => post<TerminalSession>('/api/terminals', { cwd, run }),
  killTerminal: (id: string) => post<{ ok: boolean }>(`/api/terminals/${id}/kill`, {}),
};
