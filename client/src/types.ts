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
  date: string;
  subject: string;
  refs: string;
}

export interface BranchInfo {
  name: string;
  hash: string;
  current: boolean;
  remote: boolean;
  worktreePath: string | null;
}

export interface TreeEntry {
  name: string;
  path: string;
  type: 'dir' | 'file';
  size: number;
}

export interface FileContent {
  path: string;
  content: string | null;
  binary: boolean;
  tooLarge: boolean;
  size: number;
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

export interface TerminalSession {
  id: string;
  cwd: string;
  title: string;
  status: AgentStatus;
  claudeDetected: boolean;
  createdAt: number;
  lastOutputAt: number;
}
