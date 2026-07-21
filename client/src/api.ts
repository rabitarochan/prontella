import type {
  BranchInfo,
  BranchStatus,
  CommitFile,
  DiffHunksResult,
  DiffPair,
  FileContent,
  GitOperation,
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
    request<{ branch: BranchStatus; files: StatusFile[]; merging: boolean; operation: GitOperation | null }>(
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
  diffHunks: (dir: string, path: string, scope: 'worktree' | 'staged') =>
    request<DiffHunksResult>(`/api/git/diff-hunks?dir=${q(dir)}&path=${q(path)}&scope=${q(scope)}`),
  applyHunks: (
    dir: string,
    path: string,
    scope: 'stage' | 'unstage' | 'discard',
    hunks: number[],
    expectedHunkCount: number,
    // hunks と同順・同長。選択ハンクの `@@ ...` ヘッダー文字列 — サーバー側が権威 diff の
    // 同一インデックスの header と突き合わせ、ハンク数は同じでも中身が別位置にずれた
    // 並行編集を検出する(server/index.ts の POST /api/git/apply-hunks 参照)。
    expectedHeaders: string[],
  ) => post<void>('/api/git/apply-hunks', { dir, path, scope, hunks, expectedHunkCount, expectedHeaders }),
  commitFiles: (dir: string, hash: string) =>
    request<CommitFile[]>(`/api/git/commit-files?dir=${q(dir)}&hash=${q(hash)}`),
  commitMessage: (dir: string, hash: string) =>
    request<{ message: string }>(`/api/git/commit-message?dir=${q(dir)}&hash=${q(hash)}`),
  stage: (dir: string, path: string) => post<void>('/api/git/stage', { dir, path }),
  unstage: (dir: string, path: string) => post<void>('/api/git/unstage', { dir, path }),
  commit: (dir: string, message: string, amend = false) =>
    post<{ result: string }>('/api/git/commit', { dir, message, amend }),
  stageAll: (dir: string) => post<void>('/api/git/stage-all', { dir }),
  unstageAll: (dir: string) => post<void>('/api/git/unstage-all', { dir }),
  discard: (dir: string, path: string, untracked: boolean) =>
    post<void>('/api/git/discard', { dir, path, untracked }),
  undoLastCommit: (dir: string) => post<void>('/api/git/undo-commit', { dir }),
  discardAll: (dir: string, includeUntracked: boolean) =>
    post<void>('/api/git/discard-all', { dir, includeUntracked }),
  fetch: (dir: string) => post<void>('/api/git/fetch', { dir }),
  pull: (dir: string) => post<{ result: string }>('/api/git/pull', { dir }),
  push: (dir: string) => post<{ result: string }>('/api/git/push', { dir }),
  switchBranch: (dir: string, branch: string, create = false) =>
    post<void>('/api/git/switch', { dir, branch, create }),
  deleteBranch: (dir: string, branch: string, force = false) =>
    post<void>('/api/git/branch-delete', { dir, branch, force }),
  merge: (
    dir: string,
    branch: string,
    opts?: { noFf?: boolean; ffOnly?: boolean; message?: string },
  ) => post<{ result: string }>('/api/git/merge', { dir, branch, ...opts }),
  mergeAbort: (dir: string) => post<void>('/api/git/merge-abort', { dir }),
  stashList: (dir: string) => request<StashEntry[]>(`/api/git/stash?dir=${q(dir)}`),
  stashPush: (dir: string, message?: string) => post<void>('/api/git/stash', { dir, message }),
  stashApply: (dir: string, ref: string, pop: boolean) =>
    post<void>('/api/git/stash-apply', { dir, ref, pop }),
  stashDrop: (dir: string, ref: string) => post<void>('/api/git/stash-drop', { dir, ref }),
  gitInit: (dir: string) => post<void>('/api/git/init', { dir }),

  tree: (root: string, dir = '') => request<TreeEntry[]>(`/api/fs/tree?root=${q(root)}&dir=${q(dir)}`),
  treeStatus: (root: string) => request<TreeStatusEntry[]>(`/api/fs/git-status?root=${q(root)}`),
  file: (root: string, path: string, encoding?: string) =>
    request<FileContent>(
      `/api/fs/file?root=${q(root)}&path=${q(path)}${encoding ? `&encoding=${q(encoding)}` : ''}`,
    ),
  saveFile: (
    root: string,
    path: string,
    content: string,
    opts: { encoding?: string; bom?: boolean } = {},
  ) =>
    request<void>('/api/fs/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root, path, content, encoding: opts.encoding, bom: opts.bom }),
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
