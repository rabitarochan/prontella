import * as monaco from 'monaco-editor';
import { useTheme, type ResolvedTheme } from './themeStore';

// Monaco のテーマはグローバル(setTheme は全エディター・colorize 出力に効く)なので、
// ここで一元管理する。@monaco-editor/react の theme prop も同じ値を渡しているが、
// props に紐づかない colorize(Markdown プレビュー)へ効かせるにはこの購読が必要。

export function monacoThemeName(resolved: ResolvedTheme): 'vs' | 'vs-dark' {
  return resolved === 'dark' ? 'vs-dark' : 'vs';
}

export function applyMonacoTheme(resolved: ResolvedTheme): void {
  monaco.editor.setTheme(monacoThemeName(resolved));
}

applyMonacoTheme(useTheme.getState().resolved);
useTheme.subscribe((state, prev) => {
  if (state.resolved !== prev.resolved) applyMonacoTheme(state.resolved);
});
