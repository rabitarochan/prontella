import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const US = '\x1f'; // unit separator for log formatting

// runGit(execFile の maxBuffer)と runGitInput(手動の累積バイト数ガード)で共有する出力上限
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export function runGit(
  cwd: string,
  args: string[],
  timeoutMs = 30_000,
  extraEnv?: NodeJS.ProcessEnv,
): Promise<string> {
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
        // extraEnv: 呼び出し元が個別コマンド向けに env を上書きしたいケース用
        // (例: operationAction の GIT_EDITOR=true でエディター起動を抑止)。
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
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

/**
 * ハンク単位ステージ用の権威 diff を latin1 化前提のバイト列(Buffer)で取得する。
 * getDiff() は runGit(execFile、UTF-8 デコード)を経由するため CRLF/非ASCII のバイトを
 * 崩す恐れがある — こちらは runGitInput の生 stdout をそのまま返す(呼び出し側で
 * `.toString('latin1')` してから diffPatch.ts の純関数に渡す前提)。
 */
export async function getDiffBuffer(dir: string, filePath: string, staged: boolean): Promise<Buffer> {
  const args = staged ? ['diff', '--cached', '--', filePath] : ['diff', '--', filePath];
  return runGitInput(dir, args, Buffer.alloc(0));
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

export type ConflictSide = 'ours' | 'theirs';

/**
 * 競合ファイルを ours/theirs いずれかで解決する。`checkout --ours|--theirs` は index の
 * 該当 stage(:2 / :3)の内容を作業ツリーへ復元するだけで index 自体(競合マーカーの
 * 元になっている stage :1/:2/:3 のエントリー)は更新しない。続けて `add` することで
 * stage を単一化し、マーカー解消・staged 済み状態にする。
 */
export async function resolveConflictSide(dir: string, filePath: string, side: ConflictSide): Promise<void> {
  await runGit(dir, ['checkout', `--${side}`, '--', filePath]);
  await runGit(dir, ['add', '--', filePath]);
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

export async function pull(dir: string, opts: { rebase?: boolean } = {}): Promise<string> {
  const args = ['pull'];
  if (opts.rebase) args.push('--rebase');
  return runGit(dir, args, NETWORK_TIMEOUT);
}

export async function push(
  dir: string,
  opts: { forceWithLease?: boolean } = {},
): Promise<string> {
  if (opts.forceWithLease) {
    // bare --force はミッション制約で不使用。--force-with-lease は fetch 済みの
    // remote-tracking ref (stale info) と実際のリモートを比較し、他者の push で
    // 進んでいれば拒否する (犠牲防止)。
    return runGit(dir, ['push', '--force-with-lease'], NETWORK_TIMEOUT);
  }
  try {
    await runGit(dir, ['rev-parse', '--abbrev-ref', '@{u}']);
    return await runGit(dir, ['push'], NETWORK_TIMEOUT);
  } catch {
    // no upstream yet -> publish the current branch
    return runGit(dir, ['push', '-u', 'origin', 'HEAD'], NETWORK_TIMEOUT);
  }
}

// ---- remotes ------------------------------------------------------------------

export interface RemoteInfo {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

/**
 * `git remote -v` の出力 (name / URL / (fetch|push) の 3 列、fetch と push で 2 行) を
 * name ごとに畳み込む純粋関数。URL 部は `\S+` ではなく `.+` で受ける — Windows のスペース
 * 入りパス (`C:\My Documents\repo` 等) を URL にした場合、旧実装の `\S+` は空白手前で
 * 切れてしまい行全体がマッチせず取りこぼされていた (4.R レビューで実測)。`.+` は貪欲マッチ
 * だが末尾の `\s+\((fetch|push)\)$` を満たすまでバックトラックするため、空白入り URL でも
 * 末尾の `(fetch)`/`(push)` を正しく切り離せる。テストは git.test.ts 参照。
 */
export function parseRemotesOutput(out: string): RemoteInfo[] {
  const byName = new Map<string, RemoteInfo>();
  for (const line of out.split('\n')) {
    const m = line.match(/^(\S+)\s+(.+)\s+\((fetch|push)\)$/);
    if (!m) continue;
    const [, name, url, kind] = m;
    const entry = byName.get(name) ?? { name, fetchUrl: '', pushUrl: '' };
    if (kind === 'fetch') entry.fetchUrl = url;
    else entry.pushUrl = url;
    byName.set(name, entry);
  }
  return [...byName.values()];
}

/**
 * add/remove/set-url はローカル config 操作のみでネットワークアクセスが発生しないため、
 * 他の remote 系関数と同様 NETWORK_TIMEOUT は付与しない。
 */
export async function listRemotes(dir: string): Promise<RemoteInfo[]> {
  const out = await runGit(dir, ['remote', '-v']);
  return parseRemotesOutput(out);
}

// name/url はユーザー入力をそのまま受け取るため、`-` で始まる name (例: `-f`) がオプションと
// 誤認識されない (かつ実行されない) よう `--` でオプション解析を打ち切る (4.R レビュー指摘、
// 実 git で `add`/`remove`/`set-url` いずれも `--` を受理することを確認済み)。
export async function addRemote(dir: string, name: string, url: string): Promise<void> {
  await runGit(dir, ['remote', 'add', '--', name, url]);
}

export async function removeRemote(dir: string, name: string): Promise<void> {
  await runGit(dir, ['remote', 'remove', '--', name]);
}

export async function setRemoteUrl(dir: string, name: string, url: string): Promise<void> {
  await runGit(dir, ['remote', 'set-url', '--', name, url]);
}

// ---- branches ---------------------------------------------------------------

export async function switchBranch(dir: string, branch: string, create = false): Promise<void> {
  const args = ['switch'];
  if (create) args.push('-c');
  args.push(branch);
  await runGit(dir, args);
}

/**
 * リモート追跡ブランチ (例: `origin/feature/x`) から同名のローカルブランチを作成して
 * 切り替える。`git switch --track` は -c 相当を暗黙に行い、ローカル名はリモート名を
 * 除いた部分を DWIM で自動採用する (例: `origin/feature/x` -> ローカル `feature/x`)。
 * 同名ローカルブランチが既存の場合は git 自身が拒否し、runGit が例外化する。
 * remoteBranch は listBranches() が返す git 自身の出力由来で実害はないが、新規の
 * remote 系関数群 (`--` 追加済み) との一貫性のため防御的に `--` を付ける
 * (`git switch --track --` が受理されることは実 git で確認済み)。
 */
export async function switchBranchTracking(dir: string, remoteBranch: string): Promise<void> {
  await runGit(dir, ['switch', '--track', '--', remoteBranch]);
}

export async function deleteBranch(repoPath: string, branch: string, force = false): Promise<void> {
  await runGit(repoPath, ['branch', force ? '-D' : '-d', branch]);
}

/**
 * リモートブランチを削除する (`push <remote> --delete <branch>`)。`remoteBranch` は
 * listBranches() が返す表示名 (例: `origin/feature/x`) をそのまま受け取り、最初の `/` で
 * remote 名とブランチ名に分割する (remote 名自体に `/` が入らない前提。ブランチ名側に
 * `/` を含むケース (`feature/x` 等) はそのまま branch に残る)。ネットワーク操作のため
 * NETWORK_TIMEOUT を付与する。branch は git 自身の出力由来で実害はないが、新規の remote
 * 系関数群との一貫性のため防御的に `--` を付ける (`git push <remote> --delete --` が
 * 受理されることは実 git で確認済み)。
 */
export async function deleteRemoteBranch(dir: string, remoteBranch: string): Promise<void> {
  const slash = remoteBranch.indexOf('/');
  if (slash < 0) throw new Error(`remote/branch 形式ではありません: ${remoteBranch}`);
  const remote = remoteBranch.slice(0, slash);
  const branch = remoteBranch.slice(slash + 1);
  await runGit(dir, ['push', remote, '--delete', '--', branch], NETWORK_TIMEOUT);
}

/**
 * ローカルブランチをリネームする (`branch -m`)。カレントブランチでも動作する。
 * 強制の `-M` は使わない — 新名が既存ブランチと衝突する場合は git 自身に拒否させ、
 * runGit の例外化 (呼び出し元で `{error}` に乗る) に任せる。newName はユーザー入力
 * (PromptDialog) をそのまま受け取るため、`--` を挟まないと `-f`(短縮 `--force` 相当)等が
 * オプションとして誤解釈され、意図しない強制動作に化ける恐れがある (4.R レビュー指摘。
 * 実 git で `git branch -m -- feature -f` が `fatal: '-f' is not a valid branch name` で
 * 拒否されることを確認済み)。
 */
export async function renameBranch(dir: string, oldName: string, newName: string): Promise<void> {
  await runGit(dir, ['branch', '-m', '--', oldName, newName]);
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

export type GitOperationAction = 'continue' | 'abort' | 'skip';

// merge には `git merge --skip` が存在しない(rebase/cherry-pick/revert は逐次コミット列を
// 飛ばす概念があるが、merge は単一のマージコミットしか作らないため「1 個飛ばす」がない)。
const OPERATION_SKIP_UNSUPPORTED: readonly GitOperation[] = ['merge'];

/**
 * 進行中の操作(merge/rebase/cherry-pick/revert)に対する continue/abort/skip。
 * `--continue` はコミットメッセージエディターを開こうとする(4 種いずれも)ため、
 * GIT_EDITOR=true(即成功で閉じる疑似エディター)を渡して非対話のまま既定メッセージで
 * コミットさせる。abort/skip はエディターを開かないため素通し。
 */
export async function operationAction(dir: string, kind: GitOperation, action: GitOperationAction): Promise<void> {
  if (action === 'skip' && OPERATION_SKIP_UNSUPPORTED.includes(kind)) {
    throw new Error(`${kind} に --skip は存在しません`);
  }
  const extraEnv = action === 'continue' ? { GIT_EDITOR: 'true' } : undefined;
  await runGit(dir, [kind, `--${action}`], 30_000, extraEnv);
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

export type ResetMode = 'soft' | 'mixed' | 'hard';

/**
 * HEAD (と現在のブランチ) を任意のコミットへ reset する (履歴タブのコミット行から)。
 * mode/hash のホワイトリスト・形式検証は呼び出し元 (POST /api/git/reset) の責務 — この
 * 関数自身は検証しない (operationAction/resolveConflictSide と同じ分担)。`<hash> --` の
 * ように `--` セパレーターは付けない: `git reset <commit> --` は「パス形式」(HEAD を動かさず
 * ファイルだけ index に戻す別コマンド) に解釈が変わるため、意図した「HEAD を動かす reset」に
 * ならない (実 git で確認済み)。hash はホスト側で `/^[0-9a-f]{4,40}$/i` 検証済みの前提であり、
 * `-` 始まりの値がオプションとして誤解釈される余地はない。
 */
export async function resetToCommit(dir: string, hash: string, mode: ResetMode): Promise<void> {
  await runGit(dir, ['reset', `--${mode}`, hash]);
}

/**
 * 指定コミットを現在のブランチへ cherry-pick する。hash の形式検証
 * (`/^[0-9a-f]{4,40}$/i`) は呼び出し元 (POST /api/git/cherry-pick) の責務 — この関数自身は
 * 検証しない (resetToCommit と同じ分担)。競合時は git 自身が非ゼロ終了し (作業ツリーは
 * CHERRY_PICK_HEAD が残る進行中状態になる) — runGit の例外化で呼び出し元は 500 {error} を
 * 返すだけでよく、進行中操作の検出/中止は getOperationState / operationAction (Phase 3) が
 * 既に担っている。
 */
export async function cherryPick(dir: string, hash: string): Promise<void> {
  await runGit(dir, ['cherry-pick', hash]);
}

/**
 * 指定コミットを打ち消す打ち消しコミットを作る (`revert --no-edit`)。hash の形式検証は
 * cherryPick と同じく呼び出し元 (POST /api/git/revert) の責務。`--no-edit` はコミット
 * メッセージエディターを開かず既定のメッセージ (`Revert "..."`) でそのままコミットする
 * (cherry-pick 側は追加コミットではなく既存メッセージを引き継ぐため元々エディターを
 * 開かないが、revert は既定でエディターを開こうとするため明示的に付与する)。競合時は
 * git 自身が非ゼロ終了し (作業ツリーは REVERT_HEAD が残る進行中状態になる)、続行/中止の
 * 検出は cherry-pick と同じく getOperationState / operationAction (Phase 3) が担う。
 * マージコミットの revert には `-m <parent番号>` が必須だが対応はスコープ外 — 未対応のまま
 * 渡した場合の git 自身のエラー (`error: commit ... is a merge but no -m option was given`)
 * がそのまま呼び出し元の 500 {error} としてユーザーに見える。
 */
export async function revertCommit(dir: string, hash: string): Promise<void> {
  await runGit(dir, ['revert', '--no-edit', hash]);
}

/**
 * 現在のブランチを指定ブランチ (onto) の上に rebase する (`git rebase <onto>`)。onto の
 * 先頭 `-` 拒否 (引数インジェクション対策) は呼び出し元 (POST /api/git/rebase) の責務 — この
 * 関数自身は検証しない (resetToCommit/cherryPick/revertCommit と同じ分担)。ハッシュと違い
 * ブランチ名は `/` や `.` を含み得るため hash 系のような固定書式のホワイトリスト検証はできず、
 * 先頭 `-` 拒否のみが主防壁になる (`--` セパレーターは実 git で挙動を確認できていないため
 * 付けない)。競合時は git 自身が非ゼロ終了し (作業ツリーは rebase-merge/rebase-apply が
 * 残る進行中状態になる)、続行/中止の検出は cherry-pick/revert と同じく getOperationState /
 * operationAction (Phase 3) が担う。
 */
export async function rebaseOnto(dir: string, onto: string): Promise<void> {
  await runGit(dir, ['rebase', onto]);
}
