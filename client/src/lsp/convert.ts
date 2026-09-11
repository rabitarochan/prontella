import type { IRange, languages } from 'monaco-editor';

/**
 * LSP ↔ Monaco の型変換。純関数。monaco の実体は import しない (vitest は node 環境で、
 * monaco-editor の ESM は DOM 無しでは読めない)。列挙値は monaco.d.ts の数値をここに固定する。
 *
 * 落とし穴 (docs/lsp-mvp-plan.md §5 Step 6 の表) はすべてここで吸収し、テストで固定する。
 */

// ---- LSP 側の最小型 -----------------------------------------------------------

export interface LspPosition {
  line: number;
  character: number;
}
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
export interface LspTextEdit {
  range: LspRange;
  newText: string;
}
export interface LspInsertReplaceEdit {
  newText: string;
  insert: LspRange;
  replace: LspRange;
}
export interface LspMarkupContent {
  kind: 'plaintext' | 'markdown';
  value: string;
}
export type LspMarkedString = string | { language: string; value: string };
export interface LspCompletionItem {
  label: string;
  labelDetails?: { detail?: string; description?: string };
  kind?: number;
  tags?: number[];
  detail?: string;
  documentation?: string | LspMarkupContent;
  deprecated?: boolean;
  preselect?: boolean;
  sortText?: string;
  filterText?: string;
  insertText?: string;
  insertTextFormat?: 1 | 2;
  textEdit?: LspTextEdit | LspInsertReplaceEdit;
  additionalTextEdits?: LspTextEdit[];
  commitCharacters?: string[];
  data?: unknown;
}
export interface LspCompletionList {
  isIncomplete: boolean;
  items: LspCompletionItem[];
}
export interface LspHover {
  contents: LspMarkupContent | LspMarkedString | LspMarkedString[];
  range?: LspRange;
}
export interface LspLocation {
  uri: string;
  range: LspRange;
}
export interface LspLocationLink {
  originSelectionRange?: LspRange;
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange: LspRange;
}

// ---- 位置 --------------------------------------------------------------------

/** LSP 0 起点 → Monaco 1 起点 */
export function toMonacoPosition(p: LspPosition): { lineNumber: number; column: number } {
  return { lineNumber: p.line + 1, column: p.character + 1 };
}
export function toLspPosition(p: { lineNumber: number; column: number }): LspPosition {
  return { line: p.lineNumber - 1, character: p.column - 1 };
}
export function toMonacoRange(r: LspRange): IRange {
  return {
    startLineNumber: r.start.line + 1,
    startColumn: r.start.character + 1,
    endLineNumber: r.end.line + 1,
    endColumn: r.end.character + 1,
  };
}
export function toLspRange(r: IRange): LspRange {
  return {
    start: { line: r.startLineNumber - 1, character: r.startColumn - 1 },
    end: { line: r.endLineNumber - 1, character: r.endColumn - 1 },
  };
}

// ---- 補完 --------------------------------------------------------------------

/**
 * LSP CompletionItemKind (Text=1 … TypeParameter=25) → Monaco (Method=0 … Snippet=28)。
 * 番号は完全に別物で、数値をそのまま流すと「変数が全部フォルダーアイコン」になる。
 * Monaco 側の値は monaco-editor 0.56 の monaco.d.ts から。
 */
export const MONACO_KIND = {
  Method: 0,
  Function: 1,
  Constructor: 2,
  Field: 3,
  Variable: 4,
  Class: 5,
  Struct: 6,
  Interface: 7,
  Module: 8,
  Property: 9,
  Event: 10,
  Operator: 11,
  Unit: 12,
  Value: 13,
  Constant: 14,
  Enum: 15,
  EnumMember: 16,
  Keyword: 17,
  Text: 18,
  Color: 19,
  File: 20,
  Reference: 21,
  Customcolor: 22,
  Folder: 23,
  TypeParameter: 24,
  User: 25,
  Issue: 26,
  Tool: 27,
  Snippet: 28,
} as const;

const LSP_TO_MONACO_KIND: readonly number[] = [
  MONACO_KIND.Text, // 0 (未指定)
  MONACO_KIND.Text, // 1 Text
  MONACO_KIND.Method, // 2
  MONACO_KIND.Function, // 3
  MONACO_KIND.Constructor, // 4
  MONACO_KIND.Field, // 5
  MONACO_KIND.Variable, // 6
  MONACO_KIND.Class, // 7
  MONACO_KIND.Interface, // 8
  MONACO_KIND.Module, // 9
  MONACO_KIND.Property, // 10
  MONACO_KIND.Unit, // 11
  MONACO_KIND.Value, // 12
  MONACO_KIND.Enum, // 13
  MONACO_KIND.Keyword, // 14
  MONACO_KIND.Snippet, // 15
  MONACO_KIND.Color, // 16
  MONACO_KIND.File, // 17
  MONACO_KIND.Reference, // 18
  MONACO_KIND.Folder, // 19
  MONACO_KIND.EnumMember, // 20
  MONACO_KIND.Constant, // 21
  MONACO_KIND.Struct, // 22
  MONACO_KIND.Event, // 23
  MONACO_KIND.Operator, // 24
  MONACO_KIND.TypeParameter, // 25
];

export function toMonacoKind(kind: number | undefined): number {
  return LSP_TO_MONACO_KIND[kind ?? 0] ?? MONACO_KIND.Text;
}

const INSERT_AS_SNIPPET = 4; // CompletionItemInsertTextRule.InsertAsSnippet
const TAG_DEPRECATED = 1; // CompletionItemTag.Deprecated (LSP も Monaco も 1)

/** Monaco の CompletionItem。`range` は string でなく IRange / {insert, replace} のまま。 */
export type MonacoCompletionItem = languages.CompletionItem;

/** Monaco アイテム → 元の LSP アイテム (resolve の `data` を持ち回るため)。 */
export const itemSource = new WeakMap<MonacoCompletionItem, LspCompletionItem>();

/**
 * @param defaultRange textEdit が無いときの置換範囲 (model.getWordUntilPosition から作る)。Monaco では必須
 */
export function toMonacoCompletionItem(item: LspCompletionItem, defaultRange: IRange): MonacoCompletionItem {
  let range: IRange | languages.CompletionItemRanges = defaultRange;
  let insertText = item.insertText ?? item.label;
  if (item.textEdit) {
    insertText = item.textEdit.newText;
    if ('insert' in item.textEdit) {
      // InsertReplaceEdit: 2 レンジ形式で渡す。片方だけだと「識別子の後ろが残る」
      range = { insert: toMonacoRange(item.textEdit.insert), replace: toMonacoRange(item.textEdit.replace) };
    } else {
      range = toMonacoRange(item.textEdit.range);
    }
  }
  const out: MonacoCompletionItem = {
    label: item.labelDetails ? { label: item.label, detail: item.labelDetails.detail, description: item.labelDetails.description } : item.label,
    kind: toMonacoKind(item.kind),
    insertText,
    range,
  };
  if (item.insertTextFormat === 2) out.insertTextRules = INSERT_AS_SNIPPET;
  if (item.detail !== undefined) out.detail = item.detail;
  if (item.documentation !== undefined) out.documentation = toMonacoDocumentation(item.documentation);
  if (item.sortText !== undefined) out.sortText = item.sortText;
  if (item.filterText !== undefined) out.filterText = item.filterText;
  if (item.preselect) out.preselect = true;
  if (item.commitCharacters) out.commitCharacters = item.commitCharacters;
  if (item.deprecated || item.tags?.includes(TAG_DEPRECATED)) out.tags = [TAG_DEPRECATED];
  // 自動 import の実体。落とすと「補完は入るが import が付かない」
  if (item.additionalTextEdits) out.additionalTextEdits = item.additionalTextEdits.map(toMonacoTextEdit);
  itemSource.set(out, item);
  return out;
}

/** resolve 結果を既存の Monaco アイテムへ反映する (documentation / detail / additionalTextEdits)。 */
export function applyResolved(target: MonacoCompletionItem, resolved: LspCompletionItem): MonacoCompletionItem {
  const out = { ...target };
  if (resolved.detail !== undefined) out.detail = resolved.detail;
  if (resolved.documentation !== undefined) out.documentation = toMonacoDocumentation(resolved.documentation);
  if (resolved.additionalTextEdits) out.additionalTextEdits = resolved.additionalTextEdits.map(toMonacoTextEdit);
  itemSource.set(out, resolved);
  return out;
}

export function toMonacoTextEdit(e: LspTextEdit): languages.TextEdit {
  return { range: toMonacoRange(e.range), text: e.newText };
}

export function toMonacoCompletionList(
  result: LspCompletionList | LspCompletionItem[] | null,
  defaultRange: IRange,
): languages.CompletionList | undefined {
  if (!result) return undefined;
  const items = Array.isArray(result) ? result : result.items;
  return {
    suggestions: items.map((i) => toMonacoCompletionItem(i, defaultRange)),
    // 落とすと候補が古いまま固まる
    incomplete: !Array.isArray(result) && result.isIncomplete,
  };
}

// ---- ドキュメント / ホバー ----------------------------------------------------

/**
 * 言語サーバーの出力は信頼できない入力 (pj-untrusted-input)。isTrusted / supportHtml は付けない。
 */
export function toMonacoDocumentation(doc: string | LspMarkupContent): string | languages.CompletionItem['documentation'] {
  if (typeof doc === 'string') return doc;
  return doc.kind === 'markdown' ? { value: doc.value } : doc.value;
}

function markedStringToMarkdown(m: LspMarkedString): string {
  if (typeof m === 'string') return m;
  // 旧形 {language, value} は fenced code に包み直す
  return '```' + m.language + '\n' + m.value + '\n```';
}

export function toMonacoHover(h: LspHover | null): languages.Hover | undefined {
  if (!h) return undefined;
  const c = h.contents;
  let values: string[];
  if (Array.isArray(c)) values = c.map(markedStringToMarkdown);
  else if (typeof c === 'string') values = [c];
  else if ('kind' in c) values = [c.kind === 'markdown' ? c.value : '```\n' + c.value + '\n```'];
  else values = [markedStringToMarkdown(c)];
  const out: languages.Hover = { contents: values.filter((v) => v.length > 0).map((value) => ({ value })) };
  if (h.range) out.range = toMonacoRange(h.range);
  return out;
}

// ---- 定義 --------------------------------------------------------------------

/** Monaco の LocationLink から uri だけ文字列にしたもの (monaco.Uri は呼び出し側で作る)。 */
export interface LinkTarget {
  uri: string;
  range: IRange;
  targetSelectionRange?: IRange;
  originSelectionRange?: IRange;
}

export function toLinkTargets(result: LspLocation | LspLocation[] | LspLocationLink[] | null): LinkTarget[] {
  if (!result) return [];
  const list = Array.isArray(result) ? result : [result];
  return list.map((l) =>
    'targetUri' in l
      ? {
          uri: l.targetUri,
          range: toMonacoRange(l.targetRange),
          targetSelectionRange: toMonacoRange(l.targetSelectionRange),
          ...(l.originSelectionRange ? { originSelectionRange: toMonacoRange(l.originSelectionRange) } : {}),
        }
      : { uri: l.uri, range: toMonacoRange(l.range) },
  );
}
