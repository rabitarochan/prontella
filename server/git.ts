import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const US = '\x1f'; // unit separator for log formatting

// runGit(execFile の maxBuffer)と runGitInput(手動の累積バイト数ガード)で共有する出力上限
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export function runGit(cwd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      // quotepath=false: output non-ASCII paths (日本語ファイル名 etc.) as raw
      // UTF-8 instead of octal escapes like "\346\227\245"
      ['-c', 'core.quotepath=false', ...args],
      {
        cwd,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        timeout: timeoutMs,
        // Fail fast instead of hanging when a remote asks for credentials.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.trim() || err.message));
        else resolve(stdout);
      },
    );
  });
}

/**
 * runGit と同じ設定(shell 無効・windowsHide・GIT_TERMINAL_PROMPT=0)で git を起動し、
 * input を stdin に書き込んでから閉じる。`git apply --cached --check -` のように
 * stdin からパッチ/バイナリを受け取るコマンド用。stdout/stderr は Buffer で扱う
 * (パッチにバイナリを含み得るため UTF-8 前提の execFile は使わない)。
 */
export function runGitInput(cwd: string, args: string[], input: Buffer, timeoutMs = 30_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.quotepath=false', ...args], {
      cwd,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`git ${args.join(' ')} がタイムアウトしました (${timeoutMs}ms)`));
    }, timeoutMs);

    // stdout/stderr 合算の累積バイト数が上限を超えたら kill + reject する(runGit の
    // execFile maxBuffer 相当のガード。無制限に貯め込むとメモリを圧迫するため)。
    const pushChunk = (chunks: Buffer[], chunk: Buffer) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_OUTPUT_BYTES) {
        settled = true;
        clearTimeout(timer);
        child.kill();
        reject(new Error(`git ${args.join(' ')} の出力が上限 (${MAX_OUTPUT_BYTES} バイト) を超えました`));
        return;
      }
      chunks.push(chunk);
    };

    child.stdout.on('data', (chunk: Buffer) => pushChunk(stdoutChunks, chunk));
    child.stderr.on('data', (chunk: Buffer) => pushChunk(stderrChunks, chunk));
    // 早期終了(タイムアウト kill 等)で stdin への write が EPIPE することがあるため無視する
    child.stdin.on('error', () => {});
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(Buffer.concat(stderrChunks).toString('utf8').trim() || `git exited with code ${code}`));
      } else {
        resolve(Buffer.concat(stdoutChunks));
      }
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}

const NETWORK_TIMEOUT = 120_000;

/**
 * Decode a git C-quoted path ("\346\227\245..." with surrounding quotes).
 * Even with core.quotepath=false, git still quotes paths containing
 * double quotes, backslashes, or control characters.
 */
export function unquoteGitPath(quoted: string): string {
  if (quoted.length < 2 || !quoted.startsWith('"') || !quoted.endsWith('"')) return quoted;
  const inner = quoted.slice(1, -1);
  const bytes: number[] = [];
  const SIMPLE: Record<string, string> = {
    n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', '"': '"', '\\': '\\',
  };
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '\\' && i + 1 < inner.length) {
      const next = inner[i + 1];
      if (next >= '0' && next <= '7') {
        bytes.push(parseInt(inner.slice(i + 1, i + 4), 8));
        i += 3;
      } else {
        for (const b of Buffer.from(SIMPLE[next] ?? next, 'utf8')) bytes.push(b);
        i += 1;
      }
    } else {
      for (const b of Buffer.from(ch, 'utf8')) bytes.push(b);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * dir 自身または祖先で最初に `.git` が見つかったディレクトリー(git worktree root)。
 * 見つからなければ null。git プロセスを起動しない fs ウォークアップのみで判定する
 * (GET /api/repos の 4 秒ポーリングに乗るため軽量である必要がある)。linked
 * worktree の下位でも `.git` ファイルに当たり、正しい worktree root を返す。
 */
export function resolveGitRoot(dir: string): string | null {
  let current = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null; // ドライブルートで停止
    current = parent;
  }
}

/** ユーザーの init.defaultBranch を尊重するため -b は付けない。 */
export async function init(dir: string): Promise<void> {
  await runGit(dir, ['init']);
}

/** Tracked + untracked (non-ignored) files, root-relative with forward slashes. */
export async function listFiles(dir: string): Promise<string[]> {
  // -z: NUL separators and no C-quoting — non-ASCII paths arrive as raw UTF-8
  const out = await runGit(dir, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  return out.split('\0').filter(Boolean);
}

export interface WorktreeInfo {
  path: string;
  head: string;
  branch: string | null; // null = detached HEAD
  isMain: boolean;
  locked: boolean;
}

export async function listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
  const out = await runGit(repoPath, ['worktree', 'list', '--porcelain']);
  const worktrees: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current?.path) worktrees.push(finishWorktree(current));
      current = { path: path.resolve(line.slice('worktree '.length)) };
    } else if (line.startsWith('HEAD ') && current) {
      current.head = line.slice(5, 12);
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (line.startsWith('locked') && current) {
      current.locked = true;
    }
  }
  if (current?.path) worktrees.push(finishWorktree(current));
  if (worktrees.length > 0) worktrees[0].isMain = true;
  return worktrees;
}

function finishWorktree(partial: Partial<WorktreeInfo>): WorktreeInfo {
  return {
    path: partial.path ?? '',
    head: partial.head ?? '',
    branch: partial.branch ?? null,
    isMain: false,
    locked: partial.locked ?? false,
  };
}

export interface BranchStatus {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
}

export async function getBranchStatus(dir: string): Promise<BranchStatus> {
  // untracked-files=all: count individual files inside untracked directories,
  // consistent with the file list shown in the UI
  const out = await runGit(dir, ['status', '--porcelain=v2', '--branch', '--untracked-files=all']);
  const status: BranchStatus = {
    branch: '(detached)',
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
  };
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      status.branch = line.slice('# branch.head '.length);
    } else if (line.startsWith('# branch.upstream ')) {
      status.upstream = line.slice('# branch.upstream '.length);
    } else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) {
        status.ahead = Number(m[1]);
        status.behind = Number(m[2]);
      }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const xy = line.slice(2, 4);
      if (xy[0] !== '.') status.staged++;
      if (xy[1] !== '.') status.unstaged++;
    } else if (line.startsWith('u ')) {
      status.conflicted++;
    } else if (line.startsWith('? ')) {
      status.untracked++;
    }
  }
  return status;
}

export interface StatusFile {
  path: string;
  origPath: string | null;
  staged: string; // index state: M/A/D/R/. etc
  unstaged: string; // worktree state
  untracked: boolean;
  conflicted: boolean;
}

export async function getStatusFiles(dir: string): Promise<StatusFile[]> {
  // untracked-files=all: expand untracked directories into individual files
  // (default shows only "dir/" for a fully-untracked directory)
  const out = await runGit(dir, ['status', '--porcelain=v2', '--untracked-files=all']);
  const files: StatusFile[] = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('1 ')) {
      const parts = line.split(' ');
      const xy = parts[1];
      files.push({
        path: unquoteGitPath(parts.slice(8).join(' ')),
        origPath: null,
        staged: xy[0],
        unstaged: xy[1],
        untracked: false,
        conflicted: false,
      });
    } else if (line.startsWith('2 ')) {
      // rename/copy: "2 XY sub mH mI mW hH hI X<score> path<TAB>origPath"
      const parts = line.split(' ');
      const xy = parts[1];
      const pathPart = parts.slice(9).join(' ');
      const [newPath, origPath] = pathPart.split('\t');
      files.push({
        path: unquoteGitPath(newPath),
        origPath: origPath ? unquoteGitPath(origPath) : null,
        staged: xy[0],
        unstaged: xy[1],
        untracked: false,
        conflicted: false,
      });
    } else if (line.startsWith('u ')) {
      const parts = line.split(' ');
      files.push({
        path: unquoteGitPath(parts.slice(10).join(' ')),
        origPath: null,
        staged: 'U',
        unstaged: 'U',
        untracked: false,
        conflicted: true,
      });
    } else if (line.startsWith('? ')) {
      files.push({
        path: unquoteGitPath(line.slice(2)),
        origPath: null,
        staged: '.',
        unstaged: '?',
        untracked: true,
        conflicted: false,
      });
    }
  }
  return files;
}

export interface TreeStatusEntry {
  path: string;
  state: 'new' | 'modified' | 'ignored';
  dir: boolean; // true when `path` is a directory (ignored directories collapse to one entry)
}

/**
 * Per-path git state for coloring the file tree. Unlike getStatusFiles(), this
 * also includes .gitignore'd entries (`--ignored`), reported as collapsed
 * directories or individual files. Throws on a non-git directory.
 */
export async function getTreeStatus(dir: string): Promise<TreeStatusEntry[]> {
  // Default (normal) untracked mode so fully-untracked / fully-ignored directories
  // collapse into a single "dir/" entry instead of expanding into thousands of
  // files (e.g. node_modules). Descendants are colored by prefix on the client.
  const out = await runGit(dir, ['status', '--porcelain=v2', '--ignored']);
  const entries: TreeStatusEntry[] = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('1 ')) {
      const parts = line.split(' ');
      const xy = parts[1];
      entries.push({
        path: unquoteGitPath(parts.slice(8).join(' ')),
        state: xy.includes('A') ? 'new' : 'modified',
        dir: false,
      });
    } else if (line.startsWith('2 ')) {
      const parts = line.split(' ');
      const xy = parts[1];
      const newPath = parts.slice(9).join(' ').split('\t')[0];
      entries.push({
        path: unquoteGitPath(newPath),
        state: xy.includes('A') ? 'new' : 'modified',
        dir: false,
      });
    } else if (line.startsWith('u ')) {
      const parts = line.split(' ');
      entries.push({
        path: unquoteGitPath(parts.slice(10).join(' ')),
        state: 'modified', // conflicts fold into "modified" for tree coloring
        dir: false,
      });
    } else if (line.startsWith('? ') || line.startsWith('! ')) {
      const state = line[0] === '?' ? 'new' : 'ignored';
      const raw = unquoteGitPath(line.slice(2));
      const isDir = raw.endsWith('/'); // collapsed directory entry
      entries.push({ path: isDir ? raw.slice(0, -1) : raw, state, dir: isDir });
    }
  }
  return entries;
}

export interface LogEntry {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  date: string; // committer date (ISO 8601)
  subject: string;
  refs: string;
}

export async function getLog(
  dir: string,
  limit = 100,
  opts: { ref?: string; all?: boolean } = {},
): Promise<LogEntry[]> {
  // %cI is the committer date (strict ISO 8601); LogEntry.date carries it
  const format = ['%H', '%h', '%P', '%an', '%cI', '%s', '%D'].join(US);
  // date-order sorts by committer date (descending) while still keeping a parent
  // after all of its children, which the graph layout relies on
  const args = ['log', '--date-order', `--pretty=format:${format}`, '-n', String(limit)];
  if (opts.all) args.push('--all');
  if (opts.ref) args.push(opts.ref);
  let out: string;
  try {
    out = await runGit(dir, args);
  } catch (e) {
    // empty repository (no commits yet)
    if (String(e).includes('does not have any commits')) return [];
    throw e;
  }
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, shortHash, parents, author, date, subject, refs] = line.split(US);
      return {
        hash,
        shortHash,
        parents: parents ? parents.split(' ') : [],
        author,
        date,
        subject,
        refs: refs ?? '',
      };
    });
}

export async function getCommitDetail(dir: string, hash: string): Promise<string> {
  return runGit(dir, ['show', '--patch', '--stat', '--format=fuller', hash]);
}

export interface CommitFile {
  path: string;
  origPath: string | null;
  status: string; // A/M/D/R/C/T
}

export async function getCommitFiles(dir: string, hash: string): Promise<CommitFile[]> {
  // -m --first-parent: for merge commits, list changes against the first parent
  // (matches the diff-pair endpoint, which compares hash^ .. hash)
  const out = await runGit(dir, ['show', '--name-status', '--format=', '-M', '-m', '--first-parent', hash]);
  const files: CommitFile[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0][0];
    if (status === 'R' || status === 'C') {
      files.push({ path: unquoteGitPath(parts[2]), origPath: unquoteGitPath(parts[1]), status });
    } else {
      files.push({ path: unquoteGitPath(parts[1]), origPath: null, status });
    }
  }
  return files;
}

/** Full raw commit message (subject + blank line + body, if any) for a single commit. */
export async function getCommitMessage(dir: string, hash: string): Promise<string> {
  return runGit(dir, ['log', '-1', '--format=%B', hash]);
}

/** Content of a file at a revision (e.g. "HEAD", ":0" for the index), or null if absent. */
export async function getFileAtRev(dir: string, rev: string, filePath: string): Promise<string | null> {
  try {
    return await runGit(dir, ['show', `${rev}:${filePath}`]);
  } catch {
    return null; // added/deleted at this revision, or outside the tree
  }
}

export async function getDiff(
  dir: string,
  opts: { path?: string; staged?: boolean; untracked?: boolean },
): Promise<string> {
  if (opts.untracked && opts.path) {
    // synthesize an "added file" patch for untracked files
    const abs = path.join(dir, opts.path);
    const stat = fs.statSync(abs);
    if (stat.size > 1024 * 1024) return `(新規ファイル: ${opts.path} — 1MB を超えるため省略)`;
    const content = fs.readFileSync(abs);
    if (content.includes(0)) return `(新規バイナリファイル: ${opts.path})`;
    const lines = content.toString('utf8').split('\n');
    const body = lines.map((l) => `+${l}`).join('\n');
    return `diff --git a/${opts.path} b/${opts.path}\nnew file\n--- /dev/null\n+++ b/${opts.path}\n@@ -0,0 +1,${lines.length} @@\n${body}`;
  }
  const args = ['diff'];
  if (opts.staged) args.push('--cached');
  if (opts.path) args.push('--', opts.path);
  return runGit(dir, args);
}

export interface BranchInfo {
  name: string;
  hash: string;
  current: boolean;
  remote: boolean;
  worktreePath: string | null;
}

export async function listBranches(repoPath: string): Promise<BranchInfo[]> {
  const format = ['%(refname)', '%(refname:short)', '%(objectname:short)', '%(HEAD)', '%(worktreepath)'].join(US);
  const out = await runGit(repoPath, ['branch', '-a', `--format=${format}`]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [refname, name, hash, head, worktreePath] = line.split(US);
      return {
        name,
        hash,
        current: head === '*',
        remote: refname.startsWith('refs/remotes/'),
        worktreePath: worktreePath || null,
      };
    })
    .filter((b) => !b.name.endsWith('/HEAD'));
}

export async function addWorktree(
  repoPath: string,
  worktreePath: string,
  opts: { branch?: string; newBranch?: string; base?: string },
): Promise<void> {
  const args = ['worktree', 'add'];
  if (opts.newBranch) {
    args.push('-b', opts.newBranch, worktreePath);
    if (opts.base) args.push(opts.base);
  } else if (opts.branch) {
    args.push(worktreePath, opts.branch);
  } else {
    args.push(worktreePath);
  }
  await runGit(repoPath, args);
}

export async function removeWorktree(repoPath: string, worktreePath: string, force: boolean): Promise<void> {
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(worktreePath);
  await runGit(repoPath, args);
}

export async function stageFile(dir: string, filePath: string): Promise<void> {
  await runGit(dir, ['add', '--', filePath]);
}

export async function unstageFile(dir: string, filePath: string): Promise<void> {
  await runGit(dir, ['restore', '--staged', '--', filePath]);
}

export async function stageAll(dir: string): Promise<void> {
  await runGit(dir, ['add', '-A']);
}

export async function unstageAll(dir: string): Promise<void> {
  await runGit(dir, ['reset']);
}

/** Discard working-tree changes of a tracked file (restores from the index). */
export async function discardFile(dir: string, filePath: string): Promise<void> {
  await runGit(dir, ['restore', '--', filePath]);
}

export async function commit(dir: string, message: string, amend = false): Promise<string> {
  const args = ['commit', '-m', message];
  if (amend) args.push('--amend');
  await runGit(dir, args);
  return runGit(dir, ['log', '-1', '--pretty=format:%h %s']);
}

// ---- sync -------------------------------------------------------------------

export async function fetchAll(dir: string): Promise<void> {
  await runGit(dir, ['fetch', '--all', '--prune'], NETWORK_TIMEOUT);
}

export async function pull(dir: string): Promise<string> {
  return runGit(dir, ['pull'], NETWORK_TIMEOUT);
}

export async function push(dir: string): Promise<string> {
  try {
    await runGit(dir, ['rev-parse', '--abbrev-ref', '@{u}']);
    return await runGit(dir, ['push'], NETWORK_TIMEOUT);
  } catch {
    // no upstream yet -> publish the current branch
    return runGit(dir, ['push', '-u', 'origin', 'HEAD'], NETWORK_TIMEOUT);
  }
}

// ---- branches ---------------------------------------------------------------

export async function switchBranch(dir: string, branch: string, create = false): Promise<void> {
  const args = ['switch'];
  if (create) args.push('-c');
  args.push(branch);
  await runGit(dir, args);
}

export async function deleteBranch(repoPath: string, branch: string, force = false): Promise<void> {
  await runGit(repoPath, ['branch', force ? '-D' : '-d', branch]);
}

export async function merge(
  dir: string,
  branch: string,
  opts: { noFf?: boolean; ffOnly?: boolean; message?: string } = {},
): Promise<string> {
  if (opts.noFf && opts.ffOnly) throw new Error('--no-ff と --ff-only は同時に指定できません');
  const args = ['merge'];
  if (opts.noFf) args.push('--no-ff');
  if (opts.ffOnly) args.push('--ff-only');
  if (opts.message) args.push('-m', opts.message);
  else args.push('--no-edit');
  args.push(branch);
  return runGit(dir, args);
}

export async function mergeAbort(dir: string): Promise<void> {
  await runGit(dir, ['merge', '--abort']);
}

export async function isMerging(dir: string): Promise<boolean> {
  try {
    await runGit(dir, ['rev-parse', '--verify', '-q', 'MERGE_HEAD']);
    return true;
  } catch {
    return false;
  }
}

// ---- stash ------------------------------------------------------------------

export interface StashEntry {
  ref: string; // e.g. "stash@{0}"
  message: string;
}

export async function stashList(dir: string): Promise<StashEntry[]> {
  const out = await runGit(dir, ['stash', 'list', `--format=%gd${US}%s`]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ref, message] = line.split(US);
      return { ref, message };
    });
}

export async function stashPush(dir: string, message?: string, includeUntracked = true): Promise<void> {
  const args = ['stash', 'push'];
  if (includeUntracked) args.push('-u');
  if (message) args.push('-m', message);
  await runGit(dir, args);
}

export async function stashApply(dir: string, ref: string, pop: boolean): Promise<void> {
  if (!/^stash@\{\d+\}$/.test(ref)) throw new Error(`不正な stash 参照です: ${ref}`);
  await runGit(dir, ['stash', pop ? 'pop' : 'apply', ref]);
}

export async function stashDrop(dir: string, ref: string): Promise<void> {
  if (!/^stash@\{\d+\}$/.test(ref)) throw new Error(`不正な stash 参照です: ${ref}`);
  await runGit(dir, ['stash', 'drop', ref]);
}

// ---- operation state ---------------------------------------------------------

export type GitOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert';

/**
 * 進行中の git 操作の種別。git-dir 配下のマーカーファイル/ディレクトリーで fs 判定する。
 * worktree では `.git` がファイル(gitdir へのポインター)のため resolveGitRoot ベースの
 * fs 直読みはできない — `git rev-parse --git-dir` で実体の git-dir を解決してから調べる。
 * rebase/cherry-pick 中も MERGE_HEAD 類似ファイルが併存し得るため、優先順は
 * rebase → cherry-pick → revert → merge。
 */
export async function getOperationState(dir: string): Promise<GitOperation | null> {
  let gitDir: string;
  try {
    gitDir = (await runGit(dir, ['rev-parse', '--git-dir'])).trim();
  } catch {
    return null; // git リポジトリーでない
  }
  const abs = path.isAbsolute(gitDir) ? gitDir : path.join(dir, gitDir);
  const exists = (name: string) => fs.existsSync(path.join(abs, name));
  if (exists('rebase-merge') || exists('rebase-apply')) return 'rebase';
  if (exists('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (exists('REVERT_HEAD')) return 'revert';
  if (exists('MERGE_HEAD')) return 'merge';
  return null;
}

// ---- undo ---------------------------------------------------------------------

/**
 * 直前のコミットを取り消す (`reset --soft HEAD~1`)。変更はステージ済みとして残る。
 * 親を持たない初回コミットの場合は `HEAD~1` が存在しないため、実行前に
 * `rev-parse --verify -q` で存在確認し、無ければ分かりやすい日本語エラーで reject する。
 */
export async function undoLastCommit(dir: string): Promise<void> {
  try {
    await runGit(dir, ['rev-parse', '--verify', '-q', 'HEAD~1']);
  } catch {
    throw new Error('直前のコミットがありません(初回コミットは取り消せません)');
  }
  await runGit(dir, ['reset', '--soft', 'HEAD~1']);
}

/**
 * 作業ツリーの変更をすべて破棄する。tracked ファイルは `restore`(既定のソースは
 * インデックス)で作業ツリーのみを戻し、ステージ済みの内容には触れない。
 * includeUntracked のときは未追跡ファイル/ディレクトリーも `clean -fd` で削除する。
 */
export async function discardAll(dir: string, opts: { includeUntracked: boolean }): Promise<void> {
  await runGit(dir, ['restore', '--', '.']);
  if (opts.includeUntracked) {
    await runGit(dir, ['clean', '-fd', '-q']);
  }
}
