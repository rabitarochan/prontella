// Monaco 保存まわりの純粋ヘルパー群 (FilesTab.tsx から機械的に移設)。
// React 非依存。挙動・コメントは移設元のまま — セマンティクス変更は禁止
// (pj-client-ui-state §3-4 の既定仕様)。

import * as monaco from 'monaco-editor';
import type { EditorConfigSettings } from '../../types';

export const EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  fontSize: 13,
  minimap: { enabled: true },
  scrollBeyondLastLine: false,
  automaticLayout: true,
  renderWhitespace: 'selection',
  // インデントは applyModelOptions がモデル単位で制御する(editorconfig 指定が
  // なければ手動で detectIndentation を呼ぶ)ので、attach 時の自動検出は切る。
  detectIndentation: false,
};

// editorconfig の charset → 保存時のエンコーディング指定。latin1 は iconv-lite 側の
// ホワイトリストに合わせて上位互換の windows-1252 に寄せる。utf-16 系は BOM 付きで書く。
export function charsetToEncoding(charset: EditorConfigSettings['charset']): {
  encoding: string;
  bom: boolean;
} {
  switch (charset) {
    case 'utf-8-bom':
      return { encoding: 'utf-8', bom: true };
    case 'utf-16le':
      return { encoding: 'utf-16le', bom: true };
    case 'utf-16be':
      return { encoding: 'utf-16be', bom: true };
    case 'latin1':
      return { encoding: 'windows-1252', bom: false };
    default:
      return { encoding: 'utf-8', bom: false };
  }
}

// .editorconfig の保存時整形。モデルに適用してから保存することで、エディタ表示と
// 保存内容が常に一致し、Ctrl+Z で整形前に戻せる。トリムと最終行改行は 1 回の
// pushEditOperations にまとめる(複数回に分けると undo の復元位置がずれる)。
export function formatOnSave(
  model: monaco.editor.ITextModel,
  ec: EditorConfigSettings | null,
  beforeCursorState: monaco.Selection[] | null,
  skipEol: boolean,
): void {
  if (!ec) return;
  const edits: monaco.editor.IIdentifiedSingleEditOperation[] = [];
  if (ec.trimTrailingWhitespace) {
    for (let line = 1; line <= model.getLineCount(); line++) {
      const text = model.getLineContent(line);
      const m = /[ \t]+$/.exec(text);
      if (m) edits.push({ range: new monaco.Range(line, m.index + 1, line, text.length + 1), text: '' });
    }
  }
  if (ec.insertFinalNewline) {
    const lastLine = model.getLineCount();
    const text = model.getLineContent(lastLine);
    // トリム適用後に最終行が空になるなら挿入不要。空ファイルにも挿入しない(editorconfig 仕様)。
    // 挿入位置は行末(トリム範囲の後端)なのでトリムの削除範囲とは重ならない。
    const trimmed = ec.trimTrailingWhitespace ? text.replace(/[ \t]+$/, '') : text;
    if (trimmed.length > 0) {
      edits.push({
        range: new monaco.Range(lastLine, text.length + 1, lastLine, text.length + 1),
        text: model.getEOL(),
      });
    }
  }
  model.pushStackElement();
  if (edits.length > 0) model.pushEditOperations(beforeCursorState, edits, () => null);
  // skipEol: ユーザーがステータスバーで EOL を明示選択したタブ(eolOverrideRef)では、
  // ここでの editorconfig 強制を止める(修正 A)。トリム/最終行改行は対象外なので上のブロックは常に動く。
  if (ec.endOfLine && !skipEol) {
    const want = ec.endOfLine === 'crlf' ? '\r\n' : '\n';
    if (model.getEOL() !== want) {
      model.pushEOL(
        ec.endOfLine === 'crlf'
          ? monaco.editor.EndOfLineSequence.CRLF
          : monaco.editor.EndOfLineSequence.LF,
      );
    }
  }
  model.pushStackElement();
}

// Monaco models are keyed by `path` and outlive both the editor and this
// component, so a closed tab's draft would silently resurface on reopen (or in
// another worktree, since paths are root-relative). Disposal is deferred a tick
// so React re-renders first and the editor detaches the model before we drop it.
export function disposeModelsSoon(paths: string[]) {
  setTimeout(() => {
    for (const p of paths) monaco.editor.getModel(monaco.Uri.parse(p))?.dispose();
  }, 0);
}
