// ツール呼び出し (tool_use / hook の tool_input) を「いま何をしているか」の 1 行にする。
// Agent SDK 経路 (agentSession.ts) と PTY の hook 経路 (claudeHookState.ts) の両方から使う。

const DETAIL_KEYS = ['command', 'file_path', 'pattern', 'query', 'url', 'description'] as const;
const DETAIL_MAX = 60;

/** tool_input から表示に使える 1 つの値を選び、上限まで詰めて返す。無ければ ''。 */
export function toolInputDetail(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  for (const key of DETAIL_KEYS) {
    const value = obj[key];
    if (typeof value === 'string' && value) return trim(sanitizeDetail(value), key === 'file_path');
  }
  return '';
}

// パスは頭を落として末尾を残す。先頭 60 字だと深いパスが
// "C:\Users\...\Workspace-rabitarochan\claude-dec" で切れ、どのファイルか分からなくなる。
function trim(value: string, keepTail: boolean): string {
  if (value.length <= DETAIL_MAX) return value;
  return keepTail ? '...' + value.slice(-(DETAIL_MAX - 3)) : value.slice(0, DETAIL_MAX);
}

/** "Bash: npm test" 形式の 1 行。detail が無ければツール名だけ。 */
export function toolSummary(toolName: string, input: unknown): string {
  const detail = toolInputDetail(input);
  return detail ? `${toolName}: ${detail}` : toolName;
}

// 制御バイトは「通してよいものを列挙する」方式で落とす。除外式で書くと 0x0b/0x0c を
// 素通しする (許可リストの方が壊しにくい)。改行・タブは 1 行表示では空白に潰す。
function sanitizeDetail(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      out += ' ';
    } else if (code < 0x20 || code === 0x7f) {
      continue;
    } else {
      out += ch;
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}
