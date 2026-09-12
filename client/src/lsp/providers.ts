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
  type LspCompletionItem,
  type LspCompletionList,
  type LspHover,
  type LspLocation,
  type LspLocationLink,
} from './convert';
import { documentFor, ensureModel } from './documents';
import type { LspSession } from './session';
import { modelUriString, parseModelUri, parseWireUri } from './uri';
import { getLspWorkspace } from './workspaces';

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
// ponytail: tsgo / typescript-language-server / Roslyn の triggerCharacters の和集合を静的に渡す。
// initialize の capabilities で再登録する経路は、候補の取りこぼしが観測されてから足す
const TRIGGER_CHARACTERS = ['.', '"', "'", '`', '/', '@', '<', '#', ' ', '*', '(', ':', '[', '{', '>', '~', '\\'];

const itemSession = new WeakMap<monaco.languages.CompletionItem, LspSession>();
let registered = false;

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
      const result = await doc.request<LspCompletionList | LspCompletionItem[]>(
        'textDocument/completion',
        () => ({
          textDocument: { uri: doc.uri },
          position: toLspPosition(position),
          // Monaco Invoke=0 / TriggerCharacter=1 / Incomplete=2 → LSP は 1 起点
          context: { triggerKind: context.triggerKind + 1, triggerCharacter: context.triggerCharacter },
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

  monaco.languages.registerDefinitionProvider(LANGUAGES, {
    async provideDefinition(model, position, token) {
      const doc = documentFor(model);
      if (!doc) return undefined;
      const ref = parseModelUri(model.uri.toString());
      const ws = ref && getLspWorkspace(ref.leafId);
      if (!ref || !ws) return undefined;
      const r = await doc.request<LspLocation | LspLocation[] | LspLocationLink[]>(
        'textDocument/definition',
        () => ({ textDocument: { uri: doc.uri }, position: toLspPosition(position) }),
        LOOKUP_TIMEOUT_MS,
        token,
      );
      const token2 = doc.session.rootToken;
      if (!token2) return undefined;
      const links: monaco.languages.LocationLink[] = [];
      let external = 0;
      for (const target of toLinkTargets(r)) {
        const wire = parseWireUri(token2, target.uri);
        if (!wire) continue;
        if (wire.kind === 'external') {
          external++;
          continue;
        }
        // peek (Alt+F12) はモデルが無いとプレビューが空になるので、返す前に作っておく (S1)
        const created = await ensureModel(
          ref.leafId,
          wire.path,
          async () => {
            try {
              const f = await api.file(ws.root, wire.path);
              return f.content;
            } catch {
              return null;
            }
          },
          languageFor(wire.path),
        );
        if (!created) {
          ws.notify(t('files.lsp.cannotOpenTarget', { path: wire.path }));
          continue;
        }
        links.push({ ...target, uri: monaco.Uri.parse(modelUriString(ref.leafId, wire.path)) });
      }
      if (links.length === 0 && external > 0) ws.notify(t('files.lsp.outsideWorkspace'));
      return links;
    },
  });

  // 定義ジャンプの着地: 対象モデルを表示しているエディターが無いとき Monaco がここに来る (F12 / Ctrl+クリック)。
  // FilesTab の openAtLine に流し、既存の pendingReveal → tryReveal 経路に合流させる。
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      const ref = parseModelUri(resource.toString());
      const ws = ref && getLspWorkspace(ref.leafId);
      if (!ref || !ws) return false;
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
      ws.openAtLine(ref.path, line, column);
      return true;
    },
  });
}
