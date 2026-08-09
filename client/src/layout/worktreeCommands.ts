/**
 * 表示中の WorktreeView が提供するコマンドのレジストリ。search/registry.ts の
 * FilesTabHandle と同じ流儀のモジュール状態 — コマンドパレットだけが読む。
 * WorktreeView は同時に 1 つしかマウントされない (App が key={path} で切替) ため
 * 単一スロットでよい。
 */
export interface WorktreeCommands {
  path: string;
  /** フォーカス中のタイルのターミナルで Claude Code を起動する。 */
  launchClaude: () => void;
}

let active: WorktreeCommands | null = null;

export function setActiveWorktreeCommands(cmds: WorktreeCommands): void {
  active = cmds;
}

export function clearActiveWorktreeCommands(path: string): void {
  if (active?.path === path) active = null;
}

export function getActiveWorktreeCommands(): WorktreeCommands | null {
  return active;
}
