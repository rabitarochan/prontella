import { describe, expect, it } from 'vitest';
import {
  MONACO_KIND,
  applyResolved,
  itemSource,
  toLinkTargets,
  toLspPosition,
  toLspRange,
  toMonacoCompletionItem,
  toMonacoCompletionList,
  toMonacoHover,
  toMonacoKind,
  toMonacoPosition,
  toMonacoRange,
} from './convert';

const word = { startLineNumber: 3, startColumn: 5, endLineNumber: 3, endColumn: 9 };

describe('位置と範囲', () => {
  it('LSP 0 起点 ↔ Monaco 1 起点を往復する', () => {
    expect(toMonacoPosition({ line: 0, character: 0 })).toEqual({ lineNumber: 1, column: 1 });
    expect(toLspPosition({ lineNumber: 10, column: 3 })).toEqual({ line: 9, character: 2 });
    const r = { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } };
    expect(toMonacoRange(r)).toEqual(word);
    expect(toLspRange(toMonacoRange(r))).toEqual(r);
  });
});

describe('CompletionItemKind', () => {
  it('LSP の 25 値を Monaco の番号へ写す (数値をそのまま流さない)', () => {
    // LSP: Text=1 … TypeParameter=25
    const expected = [
      MONACO_KIND.Text,
      MONACO_KIND.Method,
      MONACO_KIND.Function,
      MONACO_KIND.Constructor,
      MONACO_KIND.Field,
      MONACO_KIND.Variable,
      MONACO_KIND.Class,
      MONACO_KIND.Interface,
      MONACO_KIND.Module,
      MONACO_KIND.Property,
      MONACO_KIND.Unit,
      MONACO_KIND.Value,
      MONACO_KIND.Enum,
      MONACO_KIND.Keyword,
      MONACO_KIND.Snippet,
      MONACO_KIND.Color,
      MONACO_KIND.File,
      MONACO_KIND.Reference,
      MONACO_KIND.Folder,
      MONACO_KIND.EnumMember,
      MONACO_KIND.Constant,
      MONACO_KIND.Struct,
      MONACO_KIND.Event,
      MONACO_KIND.Operator,
      MONACO_KIND.TypeParameter,
    ];
    for (let lsp = 1; lsp <= 25; lsp++) expect(toMonacoKind(lsp), `LSP kind ${lsp}`).toBe(expected[lsp - 1]);
    // 変数 (LSP 6) がフォルダー (Monaco 23) にならない
    expect(toMonacoKind(6)).toBe(4);
    expect(toMonacoKind(undefined)).toBe(MONACO_KIND.Text);
    expect(toMonacoKind(99)).toBe(MONACO_KIND.Text);
  });
});

describe('toMonacoCompletionItem', () => {
  it('textEdit が無ければ既定範囲、insertText 無ければ label', () => {
    const m = toMonacoCompletionItem({ label: 'foo', kind: 6 }, word);
    expect(m).toMatchObject({ label: 'foo', insertText: 'foo', kind: MONACO_KIND.Variable, range: word });
    expect(m.insertTextRules).toBeUndefined();
  });

  it('TextEdit / InsertReplaceEdit (2 レンジ形式)', () => {
    const r = { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } };
    expect(toMonacoCompletionItem({ label: 'x', textEdit: { range: r, newText: 'xy' } }, word)).toMatchObject({
      insertText: 'xy',
      range: toMonacoRange(r),
    });
    const r2 = { start: { line: 0, character: 1 }, end: { line: 0, character: 6 } };
    expect(toMonacoCompletionItem({ label: 'x', textEdit: { newText: 'xy', insert: r, replace: r2 } }, word)).toMatchObject({
      insertText: 'xy',
      range: { insert: toMonacoRange(r), replace: toMonacoRange(r2) },
    });
  });

  it('InsertTextFormat 2 は InsertAsSnippet (4) を立てる', () => {
    expect(toMonacoCompletionItem({ label: 'f', insertText: 'f(${1:arg})', insertTextFormat: 2 }, word).insertTextRules).toBe(4);
    expect(toMonacoCompletionItem({ label: 'f', insertText: 'f', insertTextFormat: 1 }, word).insertTextRules).toBeUndefined();
  });

  it('additionalTextEdits (自動 import) を落とさない', () => {
    const m = toMonacoCompletionItem(
      { label: 'x', additionalTextEdits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'import x\n' }] },
      word,
    );
    expect(m.additionalTextEdits).toEqual([{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: 'import x\n' }]);
  });

  it('documentation: markdown は IMarkdownString、isTrusted / supportHtml は付けない', () => {
    const m = toMonacoCompletionItem({ label: 'x', documentation: { kind: 'markdown', value: '<b>hi</b>' } }, word);
    expect(m.documentation).toEqual({ value: '<b>hi</b>' });
    expect(toMonacoCompletionItem({ label: 'x', documentation: 'plain' }, word).documentation).toBe('plain');
    expect(toMonacoCompletionItem({ label: 'x', documentation: { kind: 'plaintext', value: 'p' } }, word).documentation).toBe('p');
  });

  it('labelDetails / deprecated / preselect / sortText / filterText / commitCharacters', () => {
    const m = toMonacoCompletionItem(
      { label: 'x', labelDetails: { detail: '(a)', description: 'mod' }, tags: [1], preselect: true, sortText: '0', filterText: 'xx', commitCharacters: ['.'] },
      word,
    );
    expect(m).toMatchObject({ label: { label: 'x', detail: '(a)', description: 'mod' }, tags: [1], preselect: true, sortText: '0', filterText: 'xx', commitCharacters: ['.'] });
    expect(toMonacoCompletionItem({ label: 'x', deprecated: true }, word).tags).toEqual([1]);
  });

  it('元の LSP アイテム (data 込み) を持ち回り、resolve 結果を反映できる', () => {
    const lsp = { label: 'x', data: { entry: 7 } };
    const m = toMonacoCompletionItem(lsp, word);
    expect(itemSource.get(m)).toBe(lsp);
    const resolved = applyResolved(m, { ...lsp, detail: 'd', documentation: 'doc', additionalTextEdits: [] });
    expect(resolved).toMatchObject({ detail: 'd', documentation: 'doc', additionalTextEdits: [] });
    expect(itemSource.get(resolved)?.data).toEqual({ entry: 7 });
  });

  it('CompletionList の isIncomplete → incomplete、配列形も受ける', () => {
    expect(toMonacoCompletionList({ isIncomplete: true, items: [{ label: 'a' }] }, word)).toMatchObject({ incomplete: true, suggestions: [{ label: 'a' }] });
    expect(toMonacoCompletionList([{ label: 'a' }], word)).toMatchObject({ incomplete: false });
    expect(toMonacoCompletionList(null, word)).toBeUndefined();
  });
});

describe('toMonacoHover', () => {
  it('MarkupContent / MarkedString / MarkedString[] の 3 形', () => {
    expect(toMonacoHover({ contents: { kind: 'markdown', value: '**b**' } })).toEqual({ contents: [{ value: '**b**' }] });
    expect(toMonacoHover({ contents: { kind: 'plaintext', value: 'p' } })).toEqual({ contents: [{ value: '```\np\n```' }] });
    expect(toMonacoHover({ contents: 'plain' })).toEqual({ contents: [{ value: 'plain' }] });
    expect(toMonacoHover({ contents: { language: 'ts', value: 'let x' } })).toEqual({ contents: [{ value: '```ts\nlet x\n```' }] });
    expect(toMonacoHover({ contents: ['a', { language: 'ts', value: 'b' }, ''] })).toEqual({ contents: [{ value: 'a' }, { value: '```ts\nb\n```' }] });
  });
  it('range と null', () => {
    const r = { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } };
    expect(toMonacoHover({ contents: 'a', range: r })?.range).toEqual(toMonacoRange(r));
    expect(toMonacoHover(null)).toBeUndefined();
  });
});

describe('toLinkTargets', () => {
  const r = { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } };
  it('LocationLink の targetUri/targetRange/targetSelectionRange → uri/range/targetSelectionRange', () => {
    expect(toLinkTargets([{ targetUri: 'file:///r1/a.ts', targetRange: r, targetSelectionRange: r, originSelectionRange: r }])).toEqual([
      { uri: 'file:///r1/a.ts', range: toMonacoRange(r), targetSelectionRange: toMonacoRange(r), originSelectionRange: toMonacoRange(r) },
    ]);
  });
  it('Location と Location[] と null', () => {
    expect(toLinkTargets({ uri: 'file:///r1/a.ts', range: r })).toEqual([{ uri: 'file:///r1/a.ts', range: toMonacoRange(r) }]);
    expect(toLinkTargets([{ uri: 'file:///r1/a.ts', range: r }])).toHaveLength(1);
    expect(toLinkTargets(null)).toEqual([]);
  });
});
