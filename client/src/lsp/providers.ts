import * as monaco from 'monaco-editor';
import { api } from '../api';
import { t } from '../i18n';
import { languageFor } from '../monaco-setup';
import {
  applyResolved,
  itemSource,
  toLinkTargets,
  toLspPosition,
  toMonacoCompletionList,
  toMonacoHover,
  toMonacoSignatureHelp,
  type LinkTarget,
  type LspCompletionItem,
  type LspCompletionList,
  type LspHover,
  type LspLocation,
  type LspLocationLink,
  type LspSignatureHelp,
} from './convert';
import { documentFor, ensureModel, type Doc } from './documents';
import { ensureExternalModel, isExternalUri } from './external';
import type { LspSession } from './session';
import { modelUriString, parseModelUri, parseWireUri } from './uri';
import { getLspWorkspace, type LspWorkspace } from './workspaces';

/**
 * Monaco のプロバイダー登録。**プロセスで 1 回だけ** (モジュールシングルトン)。FilesTab は leaf ごとに
 * 複数生存する (非表示タイルも display:none でマウント継続) ため、フック内で登録すると候補が
 * leaf の枚数だけ重複する。
 *
 * 各プロバイダーは model → documentFor() でセッションを引き、ready でなければ即 undefined
 * (未対応 root で待たない)。
 */

const LANGUAGES = ['typescript', 'javascript', 'csharp']; // Monaco の言語 id (.tsx / .jsx も同じ id)
const COMPLETION_TIMEOUT_MS = 3_000;
const LOOKUP_TIMEOUT_MS = 5_000;
// Roslyn の references は 25 プロジェクトで ≈ 2 秒 (RESULTS.md フェーズ 2)。事前生成のファイル読み出しも含む
const REFERENCES_TIMEOUT_MS = 15_000;
// 参照の着地先モデルを事前生成する上限。大きい repo で数百モデルを作らないため
const MAX_REFERENCE_MODELS = 50;
// tsgo / typescript-language-server / Roslyn の triggerCharacters の和集合を静的に登録する (Monaco の登録は 1 回)。
// LS が申告していない文字で発火したときは要求側で Invoked に落とす (session.completionTriggers)
const TRIGGER_CHARACTERS = ['.', '"', "'", '`', '/', '@', '<', '#', ' ', '*', '(', ':', '[', '{', '>', '~', '\\'];
// tsgo: `( , <` / `)`、Roslyn: `( , [ < {` / `) ] > }` の和集合
const SIGNATURE_TRIGGERS = ['(', ',', '<', '[', '{'];
const SIGNATURE_RETRIGGERS = [')', ']', '>', '}'];

const itemSession = new WeakMap<monaco.languages.CompletionItem, LspSession>();
let registered = false;

/** プロバイダーの共通前置き: 追跡中のモデルで、leaf のワークスペースが登録済みのものだけ扱う。 */
function context(model: monaco.editor.ITextModel): { doc: Doc; leafId: string; ws: LspWorkspace } | null {
  const doc = documentFor(model);
  if (!doc) return null;
  const ref = parseModelUri(model.uri.toString());
  const ws = ref && getLspWorkspace(ref.leafId);
  return ref && ws ? { doc, leafId: ref.leafId, ws } : null;
}

/**
 * LS の Location → Monaco の LocationLink。root 内は既存のファイル読み出し API でモデルを事前生成し
 * (peek はモデルが無いとプレビューが空になる — S1)、root 外 / 開けない root 内ファイル (2MB 超) は
 * `prontella-ext:` の読み取り専用モデルを作る。どちらも作れなければ落として通知する。
 */
async function toLocationLink(target: LinkTarget, ctx: { doc: Doc; leafId: string; ws: LspWorkspace }, rootToken: string): Promise<monaco.languages.LocationLink | null> {
  const wire = parseWireUri(rootToken, target.uri);
  if (!wire) return null;
  if (wire.kind === 'file') {
    const created = await ensureModel(
      ctx.leafId,
      wire.path,
      async () => {
        try {
          const f = await api.file(ctx.ws.root, wire.path);
          return f.tooLarge || f.binary ? null : f.content;
        } catch {
          return null;
        }
      },
      languageFor(wire.path),
    );
    if (created) return { ...target, uri: monaco.Uri.parse(modelUriString(ctx.leafId, wire.path)) };
  }
  const ext = await ensureExternalModel(ctx.doc.session, target.uri);
  if (!ext) {
    ctx.ws.notify(t('files.lsp.cannotOpenExternal', { name: wire.kind === 'file' ? wire.path : wire.name }));
    return null;
  }
  return { ...target, uri: ext.uri };
}

export function registerLspProviders(): void {
  if (registered) return;
  registered = true;

  monaco.languages.registerCompletionItemProvider(LANGUAGES, {
    triggerCharacters: TRIGGER_CHARACTERS,
    async provideCompletionItems(model, position, context, token) {
      const doc = documentFor(model);
      if (!doc) return undefined;
      const word = model.getWordUntilPosition(position);
      const range = { startLineNumber: position.lineNumber, startColumn: word.startColumn, endLineNumber: position.lineNumber, endColumn: word.endColumn };
      // LS が申告していない文字は Invoked に落とす (tsgo は未知の triggerCharacter で -32603 panic)。
      // 申告が未取得 (ready 直後) のときも同じ
      const known = context.triggerCharacter !== undefined && doc.session.completionTriggers?.has(context.triggerCharacter) === true;
      const result = await doc.request<LspCompletionList | LspCompletionItem[]>(
        'textDocument/completion',
        () => ({
          textDocument: { uri: doc.uri },
          position: toLspPosition(position),
          // Monaco Invoke=0 / TriggerCharacter=1 / Incomplete=2 → LSP は 1 起点
          context: context.triggerKind === 1 && !known ? { triggerKind: 1 } : { triggerKind: context.triggerKind + 1, triggerCharacter: context.triggerCharacter },
        }),
        COMPLETION_TIMEOUT_MS,
        token,
      );
      const list = toMonacoCompletionList(result, range);
      if (list) for (const s of list.suggestions) itemSession.set(s, doc.session);
      return list;
    },
    async resolveCompletionItem(item, token) {
      const source = itemSource.get(item);
      const session = itemSession.get(item);
      if (!source || !session) return item;
      const r = await session.request<LspCompletionItem>('completionItem/resolve', source, LOOKUP_TIMEOUT_MS, token);
      if ('error' in r || !r.result) return item;
      const resolved = applyResolved(item, r.result);
      itemSession.set(resolved, session);
      return resolved;
    },
  });

  monaco.languages.registerHoverProvider(LANGUAGES, {
    async provideHover(model, position, token) {
      const doc = documentFor(model);
      if (!doc) return undefined;
      const r = await doc.request<LspHover>('textDocument/hover', () => ({ textDocument: { uri: doc.uri }, position: toLspPosition(position) }), LOOKUP_TIMEOUT_MS, token);
      return toMonacoHover(r);
    },
  });

  monaco.languages.registerSignatureHelpProvider(LANGUAGES, {
    signatureHelpTriggerCharacters: SIGNATURE_TRIGGERS,
    signatureHelpRetriggerCharacters: SIGNATURE_RETRIGGERS,
    async provideSignatureHelp(model, position, token, context) {
      const doc = documentFor(model);
      if (!doc) return undefined;
      // triggerKind は Monaco 1..3 と LSP 1..3 で同じ番号。activeSignatureHelp は Monaco の形をそのまま渡せる。
      // LS が申告していないトリガー文字は Invoked に落とす (tsgo は位置の直前が `(` でないと null を返す)
      const s = doc.session;
      const ch = context.triggerCharacter;
      const known = ch !== undefined && ((context.isRetrigger && s.signatureRetriggers?.has(ch) === true) || s.signatureTriggers?.has(ch) === true);
      const r = await doc.request<LspSignatureHelp>(
        'textDocument/signatureHelp',
        () => ({
          textDocument: { uri: doc.uri },
          position: toLspPosition(position),
          context: {
            triggerKind: context.triggerKind === 2 && !known ? 1 : context.triggerKind,
            ...(context.triggerKind === 2 && known ? { triggerCharacter: ch } : {}),
            isRetrigger: context.isRetrigger,
            activeSignatureHelp: context.activeSignatureHelp,
          },
        }),
        LOOKUP_TIMEOUT_MS,
        token,
      );
      const value = toMonacoSignatureHelp(r);
      return value ? { value, dispose() {} } : undefined;
    },
  });

  monaco.languages.registerDefinitionProvider(LANGUAGES, {
    async provideDefinition(model, position, token) {
      const ctx = context(model);
      if (!ctx) return undefined;
      const r = await ctx.doc.request<LspLocation | LspLocation[] | LspLocationLink[]>(
        'textDocument/definition',
        () => ({ textDocument: { uri: ctx.doc.uri }, position: toLspPosition(position) }),
        LOOKUP_TIMEOUT_MS,
        token,
      );
      const rootToken = ctx.doc.session.rootToken;
      if (!rootToken) return undefined;
      const links: monaco.languages.LocationLink[] = [];
      for (const target of toLinkTargets(r)) {
        const link = await toLocationLink(target, ctx, rootToken);
        if (link) links.push(link);
      }
      return links;
    },
  });

  monaco.languages.registerReferenceProvider(LANGUAGES, {
    async provideReferences(model, position, _context, token) {
      const ctx = context(model);
      if (!ctx) return undefined;
      const r = await ctx.doc.request<LspLocation[]>(
        'textDocument/references',
        () => ({ textDocument: { uri: ctx.doc.uri }, position: toLspPosition(position), context: { includeDeclaration: true } }),
        REFERENCES_TIMEOUT_MS,
        token,
      );
      const rootToken = ctx.doc.session.rootToken;
      if (!rootToken) return undefined;
      const targets = toLinkTargets(r);
      const links: monaco.languages.Location[] = [];
      for (const target of targets.slice(0, MAX_REFERENCE_MODELS)) {
        const link = await toLocationLink(target, ctx, rootToken);
        if (link) links.push({ uri: link.uri, range: link.range });
      }
      if (targets.length > MAX_REFERENCE_MODELS) ctx.ws.notify(t('files.lsp.referencesTruncated', { n: MAX_REFERENCE_MODELS }));
      return links;
    },
  });

  // 定義ジャンプ / 参照の着地: 対象モデルを表示しているエディターが無いとき Monaco がここに来る (F12 / Ctrl+クリック)。
  // root 内は FilesTab の openAtLine に流し、既存の pendingReveal → tryReveal 経路に合流させる。
  // `prontella-ext:` (root 外 / 上限超え) は読み取り専用モーダル。leaf は出発点のエディターのモデルから引く
  monaco.editor.registerEditorOpener({
    openCodeEditor(source, resource, selectionOrPosition) {
      let line = 1;
      let column = 1;
      if (selectionOrPosition) {
        if ('startLineNumber' in selectionOrPosition) {
          line = selectionOrPosition.startLineNumber;
          column = selectionOrPosition.startColumn;
        } else {
          line = selectionOrPosition.lineNumber;
          column = selectionOrPosition.column;
        }
      }
      if (isExternalUri(resource)) {
        const from = source.getModel();
        const ref = from && parseModelUri(from.uri.toString());
        const ws = ref && getLspWorkspace(ref.leafId);
        const model = monaco.editor.getModel(resource);
        if (!ws || !model) return false;
        ws.openExternal(model, line, column);
        return true;
      }
      const ref = parseModelUri(resource.toString());
      const ws = ref && getLspWorkspace(ref.leafId);
      if (!ref || !ws) return false;
      ws.openAtLine(ref.path, line, column);
      return true;
    },
  });
}
