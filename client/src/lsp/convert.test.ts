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
  toMonacoMarkers,
  toMonacoPosition,
  toMonacoRange,
  toMonacoSignatureHelp,
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

describe('toMonacoMarkers', () => {
  const r = { start: { line: 4, character: 2 }, end: { line: 4, character: 9 } };
  const res = (uri: string) => (uri.startsWith('file:///r1/') ? uri.replace('file:///r1/', 'file:///leaf/') : null);
  it('severity 1..4 → 8/4/2/1、Hint は出さない、未指定は Error', () => {
    const items = [1, 2, 3, 4, undefined].map((severity) => ({ range: r, severity, message: 'm' }));
    expect(toMonacoMarkers(items, res).map((m) => m.severity)).toEqual([8, 4, 2, 8]);
  });
  it('code は文字列化、codeDescription があれば {value, target}、tags は 1/2 だけ (Roslyn の独自値は落とす)', () => {
    const [a, b] = toMonacoMarkers(
      [
        { range: r, severity: 1, code: 1134, source: 'ts', message: 'x' },
        { range: r, severity: 3, code: 'IDE0005', codeDescription: { href: 'https://x/ide0005' }, tags: [2147483641, 1, 2147483643, 2], message: 'y' },
      ],
      res,
    );
    expect(a).toEqual({ startLineNumber: 5, startColumn: 3, endLineNumber: 5, endColumn: 10, severity: 8, message: 'x', source: 'ts', code: '1134' });
    expect(b.code).toEqual({ value: 'IDE0005', target: 'https://x/ide0005' });
    expect(b.tags).toEqual([1, 2]);
    expect(toMonacoMarkers([{ range: r, message: 'z', tags: [2147483641] }], res)[0]!.tags).toBeUndefined();
  });
  it('relatedInformation は root 内だけモデル URI へ、root 外は落とす', () => {
    const [m] = toMonacoMarkers(
      [
        {
          range: r,
          message: 'x',
          relatedInformation: [
            { location: { uri: 'file:///r1/src/b.ts', range: r }, message: 'here' },
            { location: { uri: 'file:///r1-ext/e1/lib.d.ts', range: r }, message: 'lib' },
          ],
        },
      ],
      res,
    );
    expect(m.relatedInformation).toEqual([{ resource: 'file:///leaf/src/b.ts', message: 'here', startLineNumber: 5, startColumn: 3, endLineNumber: 5, endColumn: 10 }]);
    expect(toMonacoMarkers([{ range: r, message: 'x', relatedInformation: [{ location: { uri: 'file:///r1-ext/e1/lib.d.ts', range: r }, message: 'lib' }] }], res)[0]!.relatedInformation).toBeUndefined();
  });
});

describe('toMonacoSignatureHelp', () => {
  it('activeParameter はトップレベル → signature 側 → 0、null は 0', () => {
    const sig = { label: 'f(a: string, b?: number): void', parameters: [{ label: 'a: string' }, { label: [12, 22] as [number, number] }] };
    expect(toMonacoSignatureHelp({ signatures: [sig], activeSignature: 0, activeParameter: 1 })?.activeParameter).toBe(1);
    expect(toMonacoSignatureHelp({ signatures: [{ ...sig, activeParameter: 1 }], activeSignature: null, activeParameter: null })).toMatchObject({ activeSignature: 0, activeParameter: 1 });
    expect(toMonacoSignatureHelp({ signatures: [sig] })).toMatchObject({ activeSignature: 0, activeParameter: 0, signatures: [{ label: sig.label, parameters: sig.parameters }] });
    // activeSignature が範囲外なら最後に丸める
    expect(toMonacoSignatureHelp({ signatures: [sig, sig], activeSignature: 5 })?.activeSignature).toBe(1);
  });
  it('documentation は markdown を IMarkdownString に、空の signatures と null は undefined', () => {
    const h = toMonacoSignatureHelp({ signatures: [{ label: 'f()', documentation: { kind: 'markdown', value: '**d**' }, parameters: [{ label: 'x', documentation: 'pd' }] }] });
    expect(h?.signatures[0]).toEqual({ label: 'f()', documentation: { value: '**d**' }, parameters: [{ label: 'x', documentation: 'pd' }] });
    expect(toMonacoSignatureHelp({ signatures: [] })).toBeUndefined();
    expect(toMonacoSignatureHelp(null)).toBeUndefined();
  });
});

