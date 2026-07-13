import path from 'node:path';
import * as editorconfig from 'editorconfig';

// client/src/types.ts の EditorConfigSettings と手動同期(共有型機構がないため)
export interface EditorConfigSettings {
  indentStyle?: 'tab' | 'space';
  indentSize?: number;
  tabWidth?: number;
  endOfLine?: 'lf' | 'crlf'; // 'cr' は Monaco 非対応なので落とす
  charset?: 'latin1' | 'utf-8' | 'utf-8-bom' | 'utf-16be' | 'utf-16le';
  trimTrailingWhitespace?: boolean;
  insertFinalNewline?: boolean;
}

const CHARSETS = new Set(['latin1', 'utf-8', 'utf-8-bom', 'utf-16be', 'utf-16le']);

function asPositiveInt(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 && n <= 64 ? n : undefined;
}

function asBool(v: unknown): boolean | undefined {
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return undefined;
}

/**
 * abs(safeResolve 済みの絶対パス)に適用される .editorconfig 設定を解決する。
 * root オプションにより worktree ルートの .editorconfig まで見て探索を打ち切る
 * (parseSync は root 自身は path.resolve 同士の完全一致で判定するので、
 * safeResolve と同じ root 文字列から導出していれば安全に停止する)。
 * 設定が 1 つも見つからなければ null。
 */
export function resolveEditorConfig(root: string, abs: string): EditorConfigSettings | null {
  let props: editorconfig.Props;
  try {
    props = editorconfig.parseSync(abs, { root: path.resolve(root) });
  } catch {
    return null; // 壊れた .editorconfig は「設定なし」として扱う
  }

  const result: EditorConfigSettings = {};
  if (props.indent_style === 'tab') result.indentStyle = 'tab';
  else if (props.indent_style === 'space') result.indentStyle = 'space';
  const tabWidth = asPositiveInt(props.tab_width);
  if (tabWidth !== undefined) result.tabWidth = tabWidth;
  // indent_size=tab は tab_width の値に解決(editorconfig 仕様)
  const indentSize =
    props.indent_size === 'tab' ? tabWidth : asPositiveInt(props.indent_size);
  if (indentSize !== undefined) result.indentSize = indentSize;
  if (props.end_of_line === 'lf') result.endOfLine = 'lf';
  else if (props.end_of_line === 'crlf') result.endOfLine = 'crlf';
  if (typeof props.charset === 'string' && CHARSETS.has(props.charset)) {
    result.charset = props.charset as EditorConfigSettings['charset'];
  }
  const trim = asBool(props.trim_trailing_whitespace);
  if (trim !== undefined) result.trimTrailingWhitespace = trim;
  const finalNewline = asBool(props.insert_final_newline);
  if (finalNewline !== undefined) result.insertFinalNewline = finalNewline;

  return Object.keys(result).length > 0 ? result : null;
}
