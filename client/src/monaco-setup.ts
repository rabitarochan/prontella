// Bundle Monaco locally (instead of the default CDN loader) so the app works
// offline and ships self-contained via npm.
import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import { emmetCSS, emmetHTML, emmetJSX } from 'emmet-monaco-es';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case 'json':
        return new jsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker();
      case 'typescript':
      case 'javascript':
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

loader.config({ monaco });

// エディターグループの分割/畳み込みで <Editor> が再マウントされると、Monaco は
// in-flight の非同期処理 (トークナイズ・ワードハイライト等) を dispose 時に
// キャンセルし、CancellationError (name/message とも 'Canceled') が未処理の
// Promise 拒否としてコンソールへ出る。VS Code 本体も cancellation はエラー扱い
// しない (onUnexpectedError で無視する) ため、ここでその 1 形だけを狭く握る。
// アプリ側のエラーを飲み込まないよう name と message の両方で判定する。
window.addEventListener('unhandledrejection', (e) => {
  const r: unknown = e.reason;
  if (r instanceof Error && r.name === 'Canceled' && r.message === 'Canceled') e.preventDefault();
});

// Files are edited standalone (no tsconfig / node_modules resolution), so
// TypeScript's semantic diagnostics (unresolved imports, missing types) are
// all noise here — keep only genuine syntax errors.
for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
  defaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSuggestionDiagnostics: true,
    noSyntaxValidation: false,
  });
}

// tokenizer: 'standard' — the default 'monarch' mode reads Monaco internals
// (_tokenizerWithStateStore) that no longer exist in monaco-editor 0.55, which
// makes the CSS/HTML providers throw instead of suggesting.
const emmetOptions = { tokenizer: 'standard' as const };
emmetHTML(monaco, ['html', 'handlebars', 'razor'], emmetOptions);
emmetCSS(monaco, ['css', 'scss', 'less'], emmetOptions);
emmetJSX(monaco, ['javascript', 'typescript'], emmetOptions);

/** Monaco language id for a file path, via Monaco's own extension registry. */
export function languageFor(filePath: string): string | undefined {
  const name = filePath.split('/').pop() ?? filePath;
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.filenames?.some((f) => f.toLowerCase() === name.toLowerCase())) return lang.id;
    if (ext && lang.extensions?.some((e) => e.toLowerCase() === ext)) return lang.id;
  }
  return undefined;
}
