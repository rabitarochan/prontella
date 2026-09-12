// Phase 0 spike S1: does monaco.editor.registerEditorOpener fire for F12 / Ctrl+click / Alt+F12 (peek)
// when the DefinitionProvider returns a URI whose model does not exist?
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/editor/editor.worker?worker';

self.MonacoEnvironment = { getWorker: () => new editorWorker() };

const logEl = document.getElementById('log')!;
function log(s: string) {
  logEl.textContent += '\n' + s;
  console.log('[s1]', s);
}

// Language with no builtin providers so only ours runs.
monaco.languages.register({ id: 'spike' });

const target = monaco.Uri.parse('file:///leaf1/other/file.spike');

monaco.languages.registerDefinitionProvider('spike', {
  provideDefinition(model, position) {
    const word = model.getWordAtPosition(position);
    if (!word) return null;
    log(`provideDefinition ${word.word} @${position.lineNumber}:${position.column}`);
    return [
      {
        uri: target,
        range: new monaco.Range(3, 1, 3, 6),
        targetSelectionRange: new monaco.Range(3, 1, 3, 6),
      } satisfies monaco.languages.LocationLink,
    ];
  },
});

monaco.editor.registerEditorOpener({
  openCodeEditor(source, resource, selectionOrPosition) {
    log(`openCodeEditor resource=${resource.toString()} sel=${JSON.stringify(selectionOrPosition)} source=${source.getModel()?.uri.toString()}`);
    return true;
  },
});

const model = monaco.editor.createModel('hello world\nfoo bar baz\nqux', 'spike', monaco.Uri.parse('file:///leaf1/main.spike'));
const editor = monaco.editor.create(document.getElementById('ed')!, { model, automaticLayout: true });
editor.focus();
editor.setPosition({ lineNumber: 2, column: 2 });
log('ready: cursor on "foo" (2:2). Try F12 / Ctrl+click on a word / Alt+F12 (peek)');
(window as unknown as { spike: unknown }).spike = { editor, monaco, log };
