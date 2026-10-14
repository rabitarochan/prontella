import type { BpInfo } from './store';

/**
 * ブレークポイント / 現在行の Monaco 装飾を組む純関数 (monaco-editor を import しない — vitest で読めるように)。
 * 戻り値は `model.deltaDecorations` にそのまま渡せる形 (IRange はプレーンなオブジェクトでよい)。
 */

export interface Decoration {
  range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
  options: { glyphMarginClassName: string; className?: string; isWholeLine?: boolean; stickiness: number };
}

// monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges (行頭で入力しても装飾が伸びない)
const NEVER_GROWS = 1;

export function buildDecorations(lines: number[], verified: Record<number, BpInfo> | undefined, currentLine: number | null, lineCount: number, running = false): Decoration[] {
  const out: Decoration[] = [];
  const at = (line: number) => ({ startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 });
  for (const line of lines) {
    if (line < 1 || line > lineCount) continue;
    // 実行中に未検証 (応答前 / アダプターが置けなかった) → hollow。実行していないときは VS Code と同じく塗る
    const ok = !running || verified?.[line]?.verified === true;
    out.push({ range: at(line), options: { glyphMarginClassName: ok ? 'debug-bp-glyph' : 'debug-bp-glyph unverified', stickiness: NEVER_GROWS } });
  }
  if (currentLine !== null && currentLine >= 1 && currentLine <= lineCount) {
    out.push({ range: at(currentLine), options: { isWholeLine: true, className: 'debug-current-line', glyphMarginClassName: 'debug-current-glyph', stickiness: NEVER_GROWS } });
  }
  return out;
}
