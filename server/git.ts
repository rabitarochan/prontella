import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { decodeBuffer, decodeWithEncoding } from './encoding.js';
import { MAX_FILE_SIZE } from './files.js';

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
  /**
   * opts.path 指定時のみ設定される。当該コミット時点でのファイルの実際のパス
   * (--follow によるリネーム追跡の結果、opts.path に渡した現在パスと異なることがある)。
   */
  path?: string;
  /**
   * opts.path 指定時のみ設定される。リネームコミットでは親コミット時点の旧パス、
   * それ以外 (追加/変更) は null — CommitFile.origPath と同じ意味論。diff-pair の
   * scope=commit にそのまま origPath として渡せる (渡さないと、リネーム後の現在パスが
   * 親コミットに存在せず空 diff / 誤った "新規ファイル" 表示になる。実 git で確認済み)。
   */
  origPath?: string | null;
}

function parseLogLine(line: string): LogEntry {
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
}

/**
 * `git log --follow --name-status --pretty=format:<US 区切り> -- <path>` の生出力を
 * per-commit の LogEntry[] に変換する純関数(getLog から切り出し・単体テスト対象)。
 * 出力は「1 コミット = 空行区切りの複数行ブロック」(1 行目が --pretty=format 行、
 * 2 行目以降が name-status 行) になる。単一 pathspec + --follow の下では name-status
 * 行は通常ちょうど 1 行(実 git で確認済み)。マージコミット(既定の no -m では
 * name-status 行が出ない)はここで弾かれ、履歴一覧から除外される(ファイル履歴は
 * リニアな追跡が目的でマージの差分展開はスコープ外、6.3 の既知の制限)。
 */
export function parseFollowLog(out: string): LogEntry[] {
  return out
    .split('\n\n')
    .map((block) => block.trim())
    .filter(Boolean)
    .flatMap((block): LogEntry[] => {
      const lines = block.split('\n');
      const entry = parseLogLine(lines[0]);
      const nsLine = lines[1];
      if (!nsLine) return [];
      const parts = nsLine.split('\t');
      const status = parts[0][0];
      if (status === 'R' || status === 'C') {
        entry.path = unquoteGitPath(parts[2]);
        entry.origPath = unquoteGitPath(parts[1]);
      } else {
        entry.path = unquoteGitPath(parts[1]);
        entry.origPath = null;
      }
      return [entry];
    });
}

export async function getLog(
  dir: string,
  limit = 100,
  opts: { ref?: string; all?: boolean; path?: string; follow?: boolean; author?: string; grep?: string } = {},
): Promise<LogEntry[]> {
  // %cI is the committer date (strict ISO 8601); LogEntry.date carries it
  const format = ['%H', '%h', '%P', '%an', '%cI', '%s', '%D'].join(US);
  // date-order sorts by committer date (descending) while still keeping a parent
  // after all of its children, which the graph layout relies on
  const args = ['log', '--date-order', `--pretty=format:${format}`, '-n', String(limit)];
  if (opts.all) args.push('--all');
  if (opts.ref) args.push(opts.ref);
  // 履歴検索 (6.4): メッセージ (--grep) / 著者 (--author) のフリーテキスト検索。
  // `--fixed-strings` (リテラル一致) + `--regexp-ignore-case` (大小無視) を採用 — 既定の
  // 正規表現 (BRE) のままだと、検索ボックスへの自由入力がメタ文字を含む場合 (例:
  // コミットメッセージによくある "[WIP]" の `[` 単体) に不正な正規表現として git が
  // "fatal: ... Invalid regular expression" (終了コード 128 → 500) を返すことを実測で確認したため。
  // `--author=<値>` / `--grep=<値>` は `=` 埋め込みの単一 argv トークンにする (別トークンにしない) —
  // この形式では値がどんな文字列 (先頭 `-` や `--upload-pack=...` のような文字列) でも独立オプション
  // には化けない (`--author=--upload-pack=touch PWNED` が literal 文字列として扱われ何も実行され
  // ないことを実 git で確認済み) ため、呼び出し元 (GET /api/git/log) はこの 2 つの値に限り先頭 `-`
  // 拒否を課さない (`--grep=-fix` のような正当な検索語を弾かないため、意図的な判断)。
  if (opts.author || opts.grep) args.push('--fixed-strings', '--regexp-ignore-case');
  if (opts.author) args.push(`--author=${opts.author}`);
  if (opts.grep) args.push(`--grep=${opts.grep}`);
  // ファイル履歴 (6.3) / ツールバーの path 絞り込み (6.4)。opts.follow (6.3 のファイル履歴
  // モーダル) のときだけ --follow --name-status を付け、per-commit の実パスを取り出す
  // (parseFollowLog)。ツールバー版 (opts.follow なし) はリネーム追跡・per-commit パス抽出が
  // 不要な単純な pathspec フィルターとして扱う — 複数コミットのグラフ表示と絡めるため、
  // --name-status 特有の「1 コミット=複数行ブロック」パースを持ち込まない方が自然と判断
  // (実 git で両モードの出力を確認済み)。path の検証 (空/非文字列/先頭 `-`) は呼び出し元の責務
  // (pj-git-route の原則どおり)。pathspec は必ず `--` の後ろに置く。
  if (opts.path) {
    if (opts.follow) args.push('--follow', '--name-status');
    args.push('--', opts.path);
  }
  let out: string;
  try {
    out = await runGit(dir, args);
  } catch (e) {
    // empty repository (no commits yet)
    if (String(e).includes('does not have any commits')) return [];
    throw e;
  }
  return opts.follow && opts.path
    ? parseFollowLog(out)
    : out.split('\n').filter(Boolean).map(parseLogLine);
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

/**
 * スタッシュの中身を diff として表示する (`stash show -p`)。ref の形式検証
 * (`/^stash@\{\d+\}$/`) は呼び出し元 (GET /api/git/stash-show) の責務 — pj-git-route の
 * 「git.ts は薄い関数、検証はルート側」の原則どおり。stashApply/stashDrop はこの関数を
 * 導入する前から git.ts 側で検証しており (呼び出し元は asyncHandler のため無効な ref は
 * 400 ではなく 500 になる)、この既存の非対称は今回のタスクでは変更しない
 * (6.R の判断材料として報告済み)。tracked な変更のみを表示する (git 標準の既定動作) —
 * `push -u` で退避した未追跡ファイル分は含まれない (`--include-untracked` 未使用、
 * スコープ外として明示的に見送り)。
 */
export async function stashShow(dir: string, ref: string): Promise<string> {
  return runGit(dir, ['stash', 'show', '-p', ref]);
}

// ---- tags ---------------------------------------------------------------------

export interface TagInfo {
  name: string;
  hash: string;
}

export async function listTags(dir: string): Promise<TagInfo[]> {
  const format = ['%(refname:short)', '%(objectname:short)'].join(US);
  const out = await runGit(dir, ['tag', '--sort=-creatordate', `--format=${format}`]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, hash] = line.split(US);
      return { name, hash };
    });
}

/**
 * HEAD にタグを作成する。message 省略時はライトウェイトタグ、指定時は `-a -m` の注釈付き
 * タグになる。name の空/先頭 `-` 検証は呼び出し元 (POST /api/git/tag-create) の責務
 * (resetToCommit 等と同じ分担)。`--` セパレーターでオプション解析を打ち切る (`git tag -a -m
 * <msg> -- <name>` が受理されることは実 git で確認済み)。name はブランチ名同様 `/` を含み得る
 * (例: `releases/v1`) ため hash 系のような固定書式のホワイトリスト検証はできず、`--` が主防壁。
 */
export async function createTag(dir: string, name: string, message?: string): Promise<void> {
  const args = message ? ['tag', '-a', '-m', message, '--', name] : ['tag', '--', name];
  await runGit(dir, args);
}

/**
 * ローカルタグを削除する (`tag -d`)。name の検証は createTag と同じ理由で呼び出し元の責務。
 * `--` セパレーターは実 git で受理を確認済み。
 */
export async function deleteTag(dir: string, name: string): Promise<void> {
  await runGit(dir, ['tag', '-d', '--', name]);
}

/**
 * タグを origin へ push する。name の検証は createTag と同じ理由で呼び出し元の責務。
 * `git push origin -- <name>` が `--` セパレーターを受理することは実 git で確認済み。
 * ネットワーク操作のため NETWORK_TIMEOUT を付与する。
 */
export async function pushTag(dir: string, name: string): Promise<void> {
  await runGit(dir, ['push', 'origin', '--', name], NETWORK_TIMEOUT);
}

/**
 * リモート (origin) のタグを削除する (`push origin --delete <name>`)。`--delete` はコード側の
 * 固定値でありユーザー入力が入り込む余地はない。name の検証は createTag と同じ理由で呼び出し元
 * の責務 — deleteRemoteBranch と同様、`push origin --delete -- <name>` が `--` セパレーターを
 * 受理することは実 git で確認済み。ネットワーク操作のため NETWORK_TIMEOUT を付与する。
 */
export async function deleteRemoteTag(dir: string, name: string): Promise<void> {
  await runGit(dir, ['push', 'origin', '--delete', '--', name], NETWORK_TIMEOUT);
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

// ---- blame (6.5) ---------------------------------------------------------------

export interface BlameLine {
  /** 完全なコミットハッシュ(40桁)。未コミットの変更行は全て 0 (`git blame` の仕様)。 */
  hash: string;
  author: string;
  /** unix epoch 秒(porcelain の author-time をそのまま数値化)。 */
  authorTime: number;
  summary: string;
  /** この行を最後に変更したコミット時点でのファイルパス。リネームを跨ぐと問い合わせ path と異なる。 */
  path: string;
  /** 問い合わせた版のファイルにおける行番号(1-based, porcelain の final line number)。 */
  line: number;
  /** porcelain の original line number(その行を導入したコミット自身の版における行番号, 1-based)。 */
  origLine: number;
  /** ファイルの検出/指定エンコーディングでデコード済みの行内容(改行文字を含まない)。 */
  content: string;
}

export interface BlameResult {
  lines: BlameLine[];
  /** decodeBuffer が検出したエンコーディング(FileContent.encoding と同じ語彙)。バイナリ判定時は null。 */
  encoding: string | null;
  /**
   * バイナリ判定、または行復元の整合性検証に失敗した(6.5R R-1)ときに true。いずれも
   * lines は空になる — 呼び出し側は「バイナリと同じ扱い」の 1 系統として表示すればよい
   * (6.5R の指摘どおり文言をバイナリ時プレースホルダーに揃える)。
   */
  binary: boolean;
  /** files.ts の MAX_FILE_SIZE を超えるとき true(lines は空)。6.5R R-3 — エディターが開けない
   * ファイルを blame では丸ごと読めてしまう非対称を閉じるためのガード。 */
  tooLarge: boolean;
  /**
   * 未追跡ファイル等、指定 path/rev に blame 対象の履歴が無いとき true(lines は空)。
   * 6.5R R-4 — FileHistoryModal(未追跡ファイルはエラーでなく「履歴なし」として空表示)との
   * UX 対称性のため、git のエラーを呼び出し元に投げっぱなしにせずここで正常系として吸収する。
   */
  notFound: boolean;
}

/**
 * parseBlamePorcelain の中間表現。content はデコード前の latin1 文字列(1 文字 = 1 バイト。
 * Shift_JIS 等の非 UTF-8 バイト列もそのまま保持する)— decodeBlameContent がファイル全体から
 * 検出したエンコーディングで最終デコードするまでの受け渡し用。
 */
export interface RawBlameLine {
  hash: string;
  author: string;
  authorTime: number;
  summary: string;
  path: string;
  line: number;
  origLine: number;
  content: string;
}

// {40,64}: SHA-1(40桁)/SHA-256(`git init --object-format=sha256`, 64桁)の両方を受理する
// (6.5R R-2 — 40 桁固定だと SHA-256 リポジトリーの全行が下の `!m` 分岐で無言棄却され、
// 中身のあるファイルが空ファイルと区別不能になっていた)。
const BLAME_HASH_LINE = /^([0-9a-f]{40,64}) (\d+) (\d+)(?: \d+)?$/;

/**
 * latin1 文字列の部分文字列を、実バイトが UTF-8 である前提で正しくデコードする(git のメタデータ
 * 行 — author 名・commit summary・filename — は i18n.commitEncoding に関わらず常に UTF-8 で
 * 出力される。実 git で日本語 author 名・summary を確認済み)。
 */
function metaToUtf8(latin1Slice: string): string {
  return Buffer.from(latin1Slice, 'latin1').toString('utf8');
}

/**
 * `git blame --porcelain` の生出力(Buffer を `.toString('latin1')` した文字列 — バイト保存の
 * ため latin1 を経由する。diffPatch.ts の splitDiffHunks と同じ考え方)を per-line の
 * RawBlameLine[] に変換する純関数(vitest 対象)。
 *
 * 実 git で観察したフォーマット(私の実装前提と食い違った点も含む):
 * - 各行は必ず `<40桁hash> <originalLine> <finalLine>[ <groupSize>]` ヘッダーで始まり、直後に
 *   0 行以上のメタデータ行(author/author-mail/author-time/author-tz/committer 系/summary/
 *   previous/boundary/filename)、最後に必ず tab 始まりの内容行が 1 行続く。
 * - `groupSize`(4 番目の数値)は「新しい連続グループの先頭行」だけに付き、同一グループの
 *   2 行目以降は 3 フィールドのみ(このパーサーはグループを追跡せず 1 行ずつ処理するので
 *   使わない — 各行が自分の origLine/finalLine を持つため不要)。
 * - メタデータ行は「そのコミットハッシュをこの blame 呼び出しで初めて見た時」だけ出力され、
 *   2 回目以降は省略される。**同一グループ内の連続行はもちろん、非連続な別グループでも省略**
 *   される(実 git で確認済み)。「グループの先頭かどうか」と「メタデータが省略されるかどうか」
 *   は独立の 2 つの現象で、後者は純粋に「このハッシュを初めて見たか」だけで決まる。
 * - 未コミットの変更行は hash が全て 0(`0000...000`)の擬似コミットとして表現され、
 *   author に `Not Committed Yet` が入る。他のハッシュと全く同じ規則(初出時のみメタデータ、
 *   複数行にまたがれば dedup)に従う(実 git で確認済み)。
 * - 内容行はファイル末尾に改行が無くても常に `\n` で終端される(git blame 自身の出力仕様)。
 *   空行は `\t` の直後に何も続かない 1 行になる。
 * - リネームを跨ぐと、リネーム前のコミットの `filename` は問い合わせた現在パスと異なる旧パスに
 *   なる(previous 行も同様に旧パスを指す)。
 */
export function parseBlamePorcelain(text: string): RawBlameLine[] {
  const lines = text.length === 0 ? [] : text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop(); // 末尾 \n による空要素

  interface CommitMeta {
    author: string;
    authorTime: number;
    summary: string;
    path: string;
  }
  const commits = new Map<string, CommitMeta>();
  const result: RawBlameLine[] = [];
  let unmatched = 0;
  let i = 0;
  while (i < lines.length) {
    const header = lines[i];
    const m = BLAME_HASH_LINE.exec(header);
    if (!m) {
      // 想定外の行(ハッシュ長がホワイトリスト外 等)。無言で読み飛ばすと「行が欠落した
      // 正常系」に化けてしまう(6.5R R-2 — SHA-256 で全行棄却され空ファイルと区別不能になった
      // 実例)。読み飛ばし自体は無限ループ防止のため続けるが、件数を数えて最後に必ずエラーにする
      // (フェイルクローズド — 部分的な結果を正常系として返さない)。
      unmatched++;
      i++;
      continue;
    }
    const hash = m[1];
    const origLine = Number(m[2]);
    const line = Number(m[3]);
    i++;
    if (!commits.has(hash)) {
      let author = '';
      let authorTime = 0;
      let summary = '';
      let filePath = '';
      while (i < lines.length && !lines[i].startsWith('\t')) {
        const l = lines[i];
        if (l.startsWith('author ')) author = metaToUtf8(l.slice('author '.length));
        else if (l.startsWith('author-time ')) authorTime = Number(l.slice('author-time '.length));
        else if (l.startsWith('summary ')) summary = metaToUtf8(l.slice('summary '.length));
        else if (l.startsWith('filename ')) filePath = unquoteGitPath(metaToUtf8(l.slice('filename '.length)));
        i++;
      }
      commits.set(hash, { author, authorTime, summary, path: filePath });
    }
    const contentLine = lines[i] ?? '';
    const content = contentLine.startsWith('\t') ? contentLine.slice(1) : contentLine;
    i++;
    const meta = commits.get(hash)!;
    result.push({ hash, origLine, line, content, ...meta });
  }
  if (unmatched > 0) {
    throw new Error(
      `git blame の出力を解析できませんでした(想定外の形式の行が ${unmatched} 件あります)`,
    );
  }
  return result;
}

const EMPTY_LINES: BlameLine[] = [];

/**
 * RawBlameLine[](content はデコード前の latin1)から、ファイル全体のバイト列を対象に
 * decodeBuffer と同じ検出(BOM → 純 ASCII → jschardet)を 1 回だけ行い、ファイル全体を
 * 1 回でデコードしてから改めて行に分割する純関数(vitest 対象)。server/files.ts の
 * readFileContent と同じ検出ロジックを再利用することで、エディターで開いたときと同じ
 * エンコーディング判定に揃える。バイナリ判定(NUL を含む)/ 行復元の整合性検証失敗
 * (下記コメント参照)のときは lines を空にして binary:true を返す。MAX_FILE_SIZE(files.ts
 * と共通)を超えるときは lines を空にして tooLarge:true を返す(6.5R R-3)。
 * 空ファイル(rawLines.length===0)は utf-8 固定で binary:false・tooLarge:false。
 *
 * **行ごとに個別デコードしない理由(6.5R R-1 の修正)**: `git blame` はファイルを生バイト列の
 * まま `0x0A` で区切るため、UTF-16LE の改行(2 バイト `0A 00`)を跨ぐと 2 行目以降の内容が
 * 1 バイトずつ後ろにずれ、実 git で文字化けを確認した(例: UTF-16LE 4 行ファイルで
 * `GET /api/git/blame` だけ化け、`GET /api/fs/file` は正しい)。**行の再結合の段階で扱えるか
 * 自分で確かめた** — 各行の content(latin1)を `\n` で連結し直す処理(下記 contentBuf)は
 * git が消費した区切りバイトをそのまま埋め戻すため、実際には**元ファイルのバイト列を常に
 * 完全に復元できる**(1 行ずつ個別デコードするから化けるのであって、復元自体は常に正しい)。
 * そこで「復元したバイト列をエンコーディング検出後に一括デコードし、デコード後の文字列を
 * 改めて '\n' で分割し直す」方式に変更した。これは UTF-8/Shift_JIS 等では従来と同じ結果になり
 * (`0x0A` バイトがこれらのエンコーディングの非境界バイトとして出現しないため、行ごと分割と
 * 一括分割は等価)、UTF-16 では正しく整列した行を復元できる(実 git の ASCII 相当内容の
 * UTF-16LE ファイルで確認済み)。
 * ただし一般には直せない場合が残る: UTF-16 の非改行コードポイントの下位バイト(LE)/
 * 上位バイト(BE)がたまたま `0x0A` と一致する文字(例 U+300A `《`)を含むと、git 自身が
 * その位置を本物の改行と誤認して余分に分割し、`rawLines.length`(git が報告した行数)が
 * ファイルの真の行数と食い違う。これは git 自身の byte-oriented な行区切りに起因し、
 * 事後の文字列処理では原理的に検出不能な位置のズレ(本物の改行と偶然一致した非改行位置を
 * 区別する情報が失われている)なので直せない。**そこで一括デコード後に改めて '\n' で
 * 分割した行数が `rawLines.length` と一致するか検証し、一致すれば復元結果を採用、
 * 不一致なら安全側に倒して binary:true(表示できません)にする**(実 git で、この不一致
 * ケースが実際に発生すること・その他の場合は一致することの両方を確認済み)。
 */
export function decodeBlameContent(rawLines: RawBlameLine[]): BlameResult {
  if (rawLines.length === 0) {
    return { lines: EMPTY_LINES, encoding: 'utf-8', binary: false, tooLarge: false, notFound: false };
  }
  // 各行の content(latin1 = 1 文字 1 バイト)を '\n' で連結し直すことで、ファイル本体の
  // バイト列を復元する(実際の行区切りは全て '\n' なので、連結後の位置は元ファイルと一致する。
  // 1 行目の先頭がファイル先頭バイトと一致するため BOM 検出も正しく働く)。
  const contentBuf = Buffer.from(rawLines.map((l) => l.content).join('\n'), 'latin1');
  if (contentBuf.length > MAX_FILE_SIZE) {
    return { lines: EMPTY_LINES, encoding: null, binary: false, tooLarge: true, notFound: false };
  }
  const decoded = decodeBuffer(contentBuf);
  if (!decoded) return { lines: EMPTY_LINES, encoding: null, binary: true, tooLarge: false, notFound: false };
  // BOM は自前で切り落とさない — iconv-lite の decode() は utf-8/utf-16le/utf-16be いずれも
  // 先頭の BOM を自動的に除去して返すことを実測済み(decodeBuffer が対応する BOM 付きエンコー
  // ディングは全てこの 3 つ)。旧実装は files.ts の readFileContent に倣い bomLen を手動計算して
  // 1 行目だけ切り落としていたが、iconv-lite が既に無条件で剥がすため常に無効化しても出力が
  // 変わらない死んだ分岐だった(6.5R T-1 の変異テストで「bomLen 除去の変異が生存」として指摘され、
  // 実際に bomLen を 0 に固定しても全テスト green のままであることを確認した)。
  const fullText = decodeWithEncoding(contentBuf, decoded.encoding);
  const recovered = fullText.split('\n');
  if (recovered.length !== rawLines.length) {
    // git 自身の行区切りとエンコーディング上の真の行数が食い違う(上記コメントの UTF-16 の
    // 非改行コードポイントが偶然 0x0A を含むケース等)。整列できないため安全側で表示を諦める。
    return { lines: EMPTY_LINES, encoding: decoded.encoding, binary: true, tooLarge: false, notFound: false };
  }
  const lines: BlameLine[] = rawLines.map((raw, idx) => ({ ...raw, content: recovered[idx] }));
  return { lines, encoding: decoded.encoding, binary: false, tooLarge: false, notFound: false };
}

/**
 * ファイルの行単位 blame。`--porcelain`(`--line-porcelain` ではない — 後者は行ごとに全ヘッダーを
 * 繰り返し出力が肥大するため不採用)を使う。rev 省略時は既定どおり HEAD + 作業ツリー(未コミット
 * の変更行は擬似コミット `0000...000` として表現される)、rev 指定時はその版のみを見る(未コミット
 * 変更は反映されない — 実 git で確認済み)。rev/path の形式検証は呼び出し元
 * (GET /api/git/blame)の責務(pj-git-route の原則どおり)。読み取り専用 — index/worktree は
 * 一切変更しない。
 *
 * 未追跡ファイル(`?? ` 状態)や指定 rev にまだ存在しないパスは、git 自身が
 * `fatal: no such path '...' in HEAD` で非ゼロ終了する。これを呼び出し元にエラーとして
 * 投げっぱなしにすると、隣接する「ファイルの履歴...」(getLog --follow は同じ状況で
 * 単に空配列を返す — 6.5R R-4 で指摘された非対称)と体験が割れる。ここで `no such path` を
 * 検出したときだけ正常系(notFound:true, lines 空)に変換し、**それ以外の失敗(存在しない
 * rev の `bad object` 等)はそのまま再 throw する**(6.5 の敵対的入力要件 — 不正な rev は
 * 明示的なエラーのままにする、を壊さないため区別する)。
 */
export async function getBlame(dir: string, filePath: string, rev?: string): Promise<BlameResult> {
  const args = ['blame', '--porcelain'];
  if (rev) args.push(rev);
  args.push('--', filePath);
  let buf: Buffer;
  try {
    buf = await runGitInput(dir, args, Buffer.alloc(0));
  } catch (e) {
    if (String(e).includes('no such path')) {
      return { lines: [], encoding: 'utf-8', binary: false, tooLarge: false, notFound: true };
    }
    throw e;
  }
  const rawLines = parseBlamePorcelain(buf.toString('latin1'));
  return decodeBlameContent(rawLines);
}
