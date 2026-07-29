export type AgentStatus = 'busy' | 'waiting' | 'idle' | 'shell' | 'none';

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

// server/git.ts の GitOperation と手動同期(共有型機構がないため)
export type GitOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert';

// server/git.ts の GitOperationAction と手動同期(共有型機構がないため)。merge に
// 'skip' を渡すと 400(POST /api/git/operation 参照)。
export type GitOperationAction = 'continue' | 'abort' | 'skip';

// server/git.ts の ConflictSide と手動同期(共有型機構がないため)
export type ConflictSide = 'ours' | 'theirs';

// server/git.ts の ResetMode と手動同期(共有型機構がないため)
export type ResetMode = 'soft' | 'mixed' | 'hard';

export interface Worktree {
  path: string;
  head: string;
  branch: string | null;
  isMain: boolean;
  locked: boolean;
  status: BranchStatus | null;
  agent: { status: AgentStatus; terminalId: string | null };
}

export interface Repo {
  id: string;
  path: string;
  name: string;
  worktrees: Worktree[];
  error: string | null;
  gitMode: 'root' | 'subdir' | 'none'; // GET /api/repos が実行時判定で付与 — server/index.ts と手動同期(共有型機構がないため)
}

export interface StatusFile {
  path: string;
  origPath: string | null;
  staged: string;
  unstaged: string;
  untracked: boolean;
  conflicted: boolean;
}

export interface LogEntry {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  date: string; // committer date (ISO 8601)
  subject: string;
  refs: string;
  // opts.path (ファイル履歴, 6.3) 指定時のみ設定される。server/git.ts の LogEntry と手動同期
  // (共有型機構がないため)。
  path?: string;
  origPath?: string | null;
}

// server/git.ts の BranchInfo と手動同期(共有型機構がないため)
export interface BranchInfo {
  name: string;
  hash: string;
  current: boolean;
  remote: boolean;
  worktreePath: string | null;
  upstream: string | null; // 例 'origin/main'(表示用)
  upstreamFullRef: string | null; // 例 'refs/remotes/origin/main'
  upstreamRemote: string | null; // 例 'origin'
  upstreamRemoteRef: string | null; // 例 'refs/heads/main' — 短縮名 'main' のこともある
  ahead: number | null; // 不明は null(0 ではない)
  behind: number | null;
  upstreamGone: boolean;
  pushRemote: string | null; // %(push:remotename)。upstreamRemote と異なれば三角ワークフロー
  pushRef: string | null; // %(push)。空 = git がプッシュ先を一意に解決できない
}

export interface TreeEntry {
  name: string;
  path: string;
  type: 'dir' | 'file';
  size: number;
}

// server/editorconfig.ts の EditorConfigSettings と手動同期(共有型機構がないため)
export interface EditorConfigSettings {
  indentStyle?: 'tab' | 'space';
  indentSize?: number;
  tabWidth?: number;
  endOfLine?: 'lf' | 'crlf';
  charset?: 'latin1' | 'utf-8' | 'utf-8-bom' | 'utf-16be' | 'utf-16le';
  trimTrailingWhitespace?: boolean;
  insertFinalNewline?: boolean;
}

// server/files.ts の FileContent と手動同期(共有型機構がないため)
export interface FileContent {
  path: string;
  content: string | null;
  binary: boolean;
  tooLarge: boolean;
  size: number;
  encoding: string | null; // binary / tooLarge のとき null
  hasBom: boolean;
  editorconfig: EditorConfigSettings | null;
}

export interface TreeStatusEntry {
  path: string;
  state: 'new' | 'modified' | 'ignored';
  dir: boolean;
}

export interface StashEntry {
  ref: string;
  message: string;
}

// server/git.ts の TagInfo と手動同期(共有型機構がないため)
export interface TagInfo {
  name: string;
  hash: string;
}

// server/git.ts の RemoteInfo と手動同期(共有型機構がないため)
export interface RemoteInfo {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface CommitFile {
  path: string;
  origPath: string | null;
  status: string;
}

export interface DiffPair {
  original: string;
  modified: string;
  binary: boolean;
  tooLarge: boolean;
}

// server/diffPatch.ts の DiffHunk と手動同期(共有型機構がないため)
export interface DiffHunk {
  header: string;
  lines: string[];
}

// GET /api/git/diff-hunks のレスポンス形状。server/index.ts と手動同期(共有型機構がないため)
export interface DiffHunksResult {
  header: string;
  hunks: DiffHunk[];
  hunkCount: number;
  // hunks と同順・同長。楽観ロック用ハッシュ(server/diffPatch.ts の hashHunk)。
  // POST /api/git/apply-hunks の expectedHunkHashes にそのまま echo する。
  hunkHashes: string[];
}

// server/git.ts の BlameLine と手動同期(共有型機構がないため)
export interface BlameLine {
  hash: string;
  author: string;
  authorTime: number; // unix epoch 秒
  summary: string;
  path: string;
  line: number;
  origLine: number;
  content: string;
}

// GET /api/git/blame のレスポンス形状。server/index.ts と手動同期(共有型機構がないため)
export interface BlameResult {
  lines: BlameLine[];
  encoding: string | null; // バイナリ判定時・tooLarge 時は null
  // バイナリ判定、または UTF-16 等での行復元の整合性検証失敗(6.5R R-1)のとき true
  binary: boolean;
  tooLarge: boolean; // ファイルが大きすぎるとき true(6.5R R-3、files.ts の MAX_FILE_SIZE と同一閾値)
  notFound: boolean; // 未追跡ファイル等、blame 対象の履歴が無いとき true(6.5R R-4)
}

export interface SearchMatch {
  line: number; // 1-based
  column: number; // 1-based, UTF-16 code units
  preview: string;
  ranges: [number, number][]; // highlight ranges in preview, [start, end)
}

export interface SearchFileResult {
  path: string;
  matches: SearchMatch[];
}

export interface SearchTextResponse {
  results: SearchFileResult[];
  fileCount: number;
  matchCount: number;
  limitHit: boolean;
}

export interface TerminalSession {
  id: string;
  cwd: string;
  title: string;
  status: AgentStatus;
  claudeDetected: boolean;
  createdAt: number;
  lastOutputAt: number;
  statusSince: number;
}
