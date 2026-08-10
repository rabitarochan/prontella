import type {
  BlameResult,
  BranchInfo,
  BranchStatus,
  CommitFile,
  ConflictSide,
  DiffHunksResult,
  DiffPair,
  EditorConfigSettings,
  FileContent,
  GitOperation,
  GitOperationAction,
  LogEntry,
  RemoteInfo,
  Repo,
  RepoMeta,
  ResetMode,
  SearchTextResponse,
  StashEntry,
  StatusFile,
  TagInfo,
  AgentResumableSession,
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

function put<T>(url: string, body: object): Promise<T> {
  return request<T>(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function patch<T>(url: string, body: object): Promise<T> {
  return request<T>(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const q = encodeURIComponent;

export const api = {
  repos: () => request<Repo[]>('/api/repos'),
  // サーバーは RepoConfig ({ id, path, name }) を返す。戻り値は未使用のため実害は無い。
  addRepo: (path: string) => post<{ id: string; path: string; name: string }>('/api/repos', { path }),
  removeRepo: (id: string) => request<void>(`/api/repos/${id}`, { method: 'DELETE' }),
  branches: (repoId: string) => request<BranchInfo[]>(`/api/repos/${repoId}/branches`),
  reorderRepos: (order: string[]) => put<{ repos: RepoMeta[] }>('/api/repos/order', { order }),
  setRepoFlags: (id: string, flags: { pinned?: boolean } | { archived?: boolean }) =>
    patch<{ repos: RepoMeta[] }>(`/api/repos/${id}`, flags),

  addWorktree: (repoId: string, body: { branch?: string; newBranch?: string; base?: string; path?: string }) =>
    post<{ ok: boolean; path: string }>(`/api/repos/${repoId}/worktrees`, body),
  removeWorktree: (repoId: string, path: string, force: boolean) =>
    request<void>(`/api/repos/${repoId}/worktrees?path=${q(path)}&force=${force ? '1' : '0'}`, {
      method: 'DELETE',
    }),

  log: (
    dir: string,
    limit = 100,
    all = false,
    opts: {
      path?: string;
      /** true: --follow (6.3 のファイル履歴モーダル)。false/省略: 単純な pathspec 絞り込み (6.4)。 */
      follow?: boolean;
      author?: string;
      grep?: string;
    } = {},
  ) => {
    const params = new URLSearchParams({ dir, limit: String(limit) });
    if (all) params.set('all', '1');
    if (opts.path) params.set('path', opts.path);
    if (opts.follow) params.set('follow', '1');
    if (opts.author) params.set('author', opts.author);
    if (opts.grep) params.set('grep', opts.grep);
    return request<LogEntry[]>(`/api/git/log?${params}`);
  },
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
    // hunks と同順・同長。GET /api/git/diff-hunks が返した hunkHashes からそのハンクの
    // 値をそのまま渡す。サーバー側が権威 diff から同じ関数(hashHunk)でハッシュを
    // 再計算して突き合わせ、ハンク本体(ヘッダー+全内容行、バイト保存)の不一致を
    // 行選択の有無にかかわらず無条件で検出する(server/diffPatch.ts の hashHunk /
    // checkApplyHunksRequest 参照。不具合2/3の修正: 以前の expectedHeaders/
    // expectedHunkLines(utf8 文字列比較・行選択があるハンクのみ)を置き換えた)。
    expectedHunkHashes: string[],
    // 2.4 行単位ステージ用。hunks と同順・同長。要素は「そのハンクの hunk.lines への
    // インデックス配列」または null(= そのハンク全行選択。従来どおりの挙動)。
    // 省略時はハンク単位ステージ(全ハンク全行選択)として扱われる(server 側デフォルト)。
    lines?: (number[] | null)[],
  ) =>
    post<void>('/api/git/apply-hunks', {
      dir,
      path,
      scope,
      hunks,
      expectedHunkCount,
      expectedHunkHashes,
      lines,
    }),
  blame: (dir: string, path: string, rev?: string) => {
    const params = new URLSearchParams({ dir, path });
    if (rev) params.set('rev', rev);
    return request<BlameResult>(`/api/git/blame?${params}`);
  },
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
  reset: (dir: string, hash: string, mode: ResetMode) => post<void>('/api/git/reset', { dir, hash, mode }),
  cherryPick: (dir: string, hash: string) => post<void>('/api/git/cherry-pick', { dir, hash }),
  revert: (dir: string, hash: string) => post<void>('/api/git/revert', { dir, hash }),
  rebase: (dir: string, onto: string) => post<void>('/api/git/rebase', { dir, onto }),
  discardAll: (dir: string, includeUntracked: boolean) =>
    post<void>('/api/git/discard-all', { dir, includeUntracked }),
  fetch: (dir: string) => post<void>('/api/git/fetch', { dir }),
  pull: (dir: string, opts?: { rebase?: boolean }) =>
    post<{ result: string }>('/api/git/pull', { dir, rebase: opts?.rebase === true }),
  push: (dir: string, opts?: { forceWithLease?: boolean }) =>
    post<{ result: string }>('/api/git/push', {
      dir,
      forceWithLease: opts?.forceWithLease === true,
    }),
  switchBranch: (dir: string, branch: string, create = false) =>
    post<void>('/api/git/switch', { dir, branch, create }),
  // リモート追跡ブランチ (例: origin/feature/x) から同名ローカルブランチを作成して切り替える
  switchBranchTracking: (dir: string, remoteBranch: string) =>
    post<void>('/api/git/switch', { dir, branch: remoteBranch, track: true }),
  deleteBranch: (dir: string, branch: string, force = false) =>
    post<void>('/api/git/branch-delete', { dir, branch, force }),
  renameBranch: (dir: string, oldName: string, newName: string) =>
    post<void>('/api/git/branch-rename', { dir, oldName, newName }),
  deleteRemoteBranch: (dir: string, remoteBranch: string) =>
    post<void>('/api/git/branch-delete-remote', { dir, remoteBranch }),
  branchFetchFf: (dir: string, branch: string) =>
    post<{ result: string }>('/api/git/branch-fetch-ff', { dir, branch }),
  branchPush: (dir: string, branch: string, remoteBranch: string) =>
    post<{ result: string }>('/api/git/branch-push', { dir, branch, remoteBranch }),
  remotes: (dir: string) => request<RemoteInfo[]>(`/api/git/remotes?dir=${q(dir)}`),
  addRemote: (dir: string, name: string, url: string) =>
    post<void>('/api/git/remote-add', { dir, name, url }),
  removeRemote: (dir: string, name: string) => post<void>('/api/git/remote-remove', { dir, name }),
  setRemoteUrl: (dir: string, name: string, url: string) =>
    post<void>('/api/git/remote-set-url', { dir, name, url }),
  merge: (
    dir: string,
    branch: string,
    opts?: { noFf?: boolean; ffOnly?: boolean; message?: string },
  ) => post<{ result: string }>('/api/git/merge', { dir, branch, ...opts }),
  mergeAbort: (dir: string) => post<void>('/api/git/merge-abort', { dir }),
  operationAction: (dir: string, kind: GitOperation, action: GitOperationAction) =>
    post<void>('/api/git/operation', { dir, kind, action }),
  resolveSide: (dir: string, path: string, side: ConflictSide) =>
    post<void>('/api/git/resolve-side', { dir, path, side }),
  stashList: (dir: string) => request<StashEntry[]>(`/api/git/stash?dir=${q(dir)}`),
  stashPush: (dir: string, message?: string) => post<void>('/api/git/stash', { dir, message }),
  stashApply: (dir: string, ref: string, pop: boolean) =>
    post<void>('/api/git/stash-apply', { dir, ref, pop }),
  stashDrop: (dir: string, ref: string) => post<void>('/api/git/stash-drop', { dir, ref }),
  stashShow: (dir: string, ref: string) =>
    request<{ text: string }>(`/api/git/stash-show?dir=${q(dir)}&ref=${q(ref)}`),
  tags: (dir: string) => request<TagInfo[]>(`/api/git/tags?dir=${q(dir)}`),
  createTag: (dir: string, name: string, message?: string) =>
    post<void>('/api/git/tag-create', { dir, name, message }),
  deleteTag: (dir: string, name: string) => post<void>('/api/git/tag-delete', { dir, name }),
  pushTag: (dir: string, name: string) => post<void>('/api/git/tag-push', { dir, name }),
  deleteRemoteTag: (dir: string, name: string) =>
    post<void>('/api/git/tag-delete-remote', { dir, name }),
  gitInit: (dir: string) => post<void>('/api/git/init', { dir }),

  tree: (root: string, dir = '') => request<TreeEntry[]>(`/api/fs/tree?root=${q(root)}&dir=${q(dir)}`),
  treeStatus: (root: string) => request<TreeStatusEntry[]>(`/api/fs/git-status?root=${q(root)}`),
  file: (root: string, path: string, encoding?: string) =>
    request<FileContent>(
      `/api/fs/file?root=${q(root)}&path=${q(path)}${encoding ? `&encoding=${q(encoding)}` : ''}`,
    ),
  // fetch でなく URL ビルダー(<img src> にそのまま入れるため)。相対 URL にして
  // Vite dev のプロキシと本番の同一オリジン配信の両方で動くようにする。
  rawUrl: (root: string, path: string): string => `/api/fs/raw?root=${q(root)}&path=${q(path)}`,
  editorConfig: (root: string, path: string) =>
    request<EditorConfigSettings | null>(`/api/fs/editorconfig?root=${q(root)}&path=${q(path)}`),
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
  createAgent: (cwd: string, resume?: string) => post<TerminalSession>('/api/agents', { cwd, resume }),
  agentResumable: (cwd: string) =>
    request<AgentResumableSession[]>(`/api/agents/resumable?cwd=${q(cwd)}`),
  discardAgentRecord: (deckId: string) =>
    post<{ ok: boolean }>(`/api/agents/resumable/${deckId}/discard`, {}),
  killTerminal: (id: string) => post<{ ok: boolean }>(`/api/terminals/${id}/kill`, {}),
};
