/**
 * /ws/term の入力メッセージ検証 (純関数、node-pty 非依存)。
 *
 * resize はどの attach ソケットからでも来る (last-write-wins)。クライアントは
 * 「ページがアクティブなときだけ送る」規律を持つが、サーバー側は形と範囲だけを
 * 検証して `proc.resize` に渡す前の防壁とする。範囲は ConPTY / xterm の実用域。
 */

export const MIN_COLS = 2;
export const MAX_COLS = 1000;
export const MIN_ROWS = 1;
export const MAX_ROWS = 1000;

export interface TermSize {
  cols: number;
  rows: number;
}

export function parseResizeMessage(msg: unknown): TermSize | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const { cols, rows } = msg as { cols?: unknown; rows?: unknown };
  if (typeof cols !== 'number' || typeof rows !== 'number') return null;
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return null;
  if (cols < MIN_COLS || cols > MAX_COLS) return null;
  if (rows < MIN_ROWS || rows > MAX_ROWS) return null;
  return { cols, rows };
}
