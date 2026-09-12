import * as monaco from 'monaco-editor';
import { toLspRange } from './convert';
import { languageIdFor, serverIdFor, type ServerId } from './languages';
import { NOT_OWNER, getLspSession, type LspResult, type LspSession } from './session';
import { modelUriString, parseModelUri, toWireUri } from './uri';
import { getLspWorkspace, onLspWorkspaceRegistered } from './workspaces';

/**
 * Monaco モデル ↔ LSP ドキュメントの同期。React ではなく monaco.editor.onDidCreateModel /
 * onWillDisposeModel に乗る (useGitGutter と同型): モデルは keepCurrentModel でコンポーネントより
 * 長生きするので、React に載せると分割・プレビュー往復・再マウントで didOpen/didClose が乱発される。
 *
 * - incremental 同期。ただし isFlush (setValue: 外部変更の取り込み・エンコーディング再読込) と
 *   isEolChange (setEOL / formatOnSave) は全文で送る。落とすと LSP 側だけ古い本文で固定され、
 *   見た目に何も起きないので発見が遅れる
 * - didChange はデバウンスしない (遅らせると「補完要求時点のサーバー側テキストが古い」を生む)
 * - オーナーシップ: 同じ worktree を 2 タイルで開くと同一パスに 2 モデルができる (LSP は 1 ファイル
 *   1 ドキュメント)。最初に開いたモデルが owner で didChange を送るのは owner だけ。非 owner から
 *   要求するときは、そのモデルの全文で didOpen し直して owner を移してから要求する
 *   (サーバーは既知の doc への didOpen を全文 didChange として扱う)。別ブラウザータブとの競合も
 *   同じ形で解ける: サーバーが -32803 (not-owner) を返したら全文 didOpen して 1 回だけ再要求する
 */

interface Tracked {
  model: monaco.editor.ITextModel;
  leafId: string;
  path: string;
  session: LspSession;
  languageId: string;
  /** root + path。owner 表と version 表のキー */
  key: string;
  disposables: monaco.IDisposable[];
}

export interface Doc {
  session: LspSession;
  /** ワイヤー URI (rootToken 確定後のみ) */
  uri: string;
  /** このモデルを owner にする (必要なら全文で didOpen)。要求の直前に呼ぶ */
  ensureOwner(): void;
  /** not-owner なら全文 didOpen して 1 回だけ再要求する */
  request<T>(method: string, params: () => unknown, timeoutMs: number, cancel?: Parameters<LspSession['request']>[3]): Promise<T | null>;
}

const tracked = new Map<monaco.editor.ITextModel, Tracked>();
const owners = new Map<string, monaco.editor.ITextModel>();
const versions = new Map<string, number>();
/** leafId 未登録で保留中のモデル */
const pendingModels = new Set<monaco.editor.ITextModel>();
const sessionsWired = new WeakSet<LspSession>();
let started = false;
let enabledServers: ReadonlySet<ServerId> = new Set();

export function startLspDocuments(enabled: ReadonlySet<ServerId>): void {
  if (started) return;
  started = true;
  enabledServers = enabled;
  for (const model of monaco.editor.getModels()) track(model);
  monaco.editor.onDidCreateModel(track);
  monaco.editor.onWillDisposeModel(untrack);
  onLspWorkspaceRegistered(() => {
    for (const m of [...pendingModels]) track(m);
  });
}

function nextVersion(key: string): number {
  const v = (versions.get(key) ?? 0) + 1;
  versions.set(key, v);
  return v;
}

function wireUri(t: Tracked): string | null {
  return t.session.rootToken ? toWireUri(t.session.rootToken, t.path) : null;
}

function sendOpen(t: Tracked): void {
  const uri = wireUri(t);
  if (!uri) return;
  owners.set(t.key, t.model);
  t.session.notify('textDocument/didOpen', {
    textDocument: { uri, languageId: t.languageId, version: nextVersion(t.key), text: t.model.getValue() },
  });
}

function track(model: monaco.editor.ITextModel): void {
  if (tracked.has(model)) return;
  const ref = parseModelUri(model.uri.toString());
  if (!ref) return;
  const languageId = languageIdFor(ref.path);
  if (!languageId) return;
  const serverId = serverIdFor(languageId);
  if (!enabledServers.has(serverId)) return;
  const ws = getLspWorkspace(ref.leafId);
  if (!ws) {
    pendingModels.add(model);
    return;
  }
  pendingModels.delete(model);
  const session = getLspSession(ws.root, serverId);
  wireSession(session);
  const key = `${ws.root}\0${ref.path}`;
  const t: Tracked = { model, leafId: ref.leafId, path: ref.path, session, languageId, key, disposables: [] };
  tracked.set(model, t);
  t.disposables.push(
    model.onDidChangeContent((e) => {
      if (owners.get(key) !== model) return;
      const uri = wireUri(t);
      if (!uri) return;
      const version = nextVersion(key);
      const contentChanges =
        e.isFlush || e.isEolChange
          ? [{ text: model.getValue() }]
          : // Monaco は後方→前方の順で渡す。並べ替えない
            e.changes.map((c) => ({ range: toLspRange(c.range), rangeLength: c.rangeLength, text: c.text }));
      session.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges });
    }),
  );
  if (!owners.has(key)) sendOpen(t);
}

function untrack(model: monaco.editor.ITextModel): void {
  pendingModels.delete(model);
  const t = tracked.get(model);
  if (!t) return;
  tracked.delete(model);
  for (const d of t.disposables) d.dispose();
  if (owners.get(t.key) !== model) return;
  owners.delete(t.key);
  // 同じファイルの別モデルが残っていればそちらへ移す (全文で同期し直す)
  for (const other of tracked.values()) {
    if (other.key === t.key) {
      sendOpen(other);
      return;
    }
  }
  const uri = wireUri(t);
  if (uri) t.session.notify('textDocument/didClose', { textDocument: { uri } });
  versions.delete(t.key);
}

/** 接続 (再接続) 直後と LS の再起動後: サーバーは doc を何も知らないので全部開き直す。 */
function reopenAll(session: LspSession): void {
  const done = new Set<string>();
  for (const t of tracked.values()) {
    if (t.session !== session || done.has(t.key)) continue;
    done.add(t.key);
    const owner = owners.get(t.key);
    const target = owner ? tracked.get(owner) ?? t : t;
    sendOpen(target);
  }
}

function wireSession(session: LspSession): void {
  if (sessionsWired.has(session)) return;
  sessionsWired.add(session);
  // rootToken は status 通知で届く。onOpen 時点ではまだ無いことがあるので、token が届いた時に開き直す。
  // C# はサーバー側が didOpen を受けて初めてプロセスを起動する (最寄りの .sln 単位) ので、
  // ready を待ってから送るのでは永久に始まらない — 'stopped' でも token があれば送る
  session.onOpen.add(() => reopenAll(session));
  session.onReset.add(() => reopenAll(session));
  let hadToken = false;
  session.subscribe(() => {
    const has = session.rootToken !== null;
    if (has && !hadToken) reopenAll(session);
    hadToken = has;
  });
}

/** プロバイダー用。追跡外のモデル (対応外の拡張子・未登録 leaf・競合ペイン) は null。 */
export function documentFor(model: monaco.editor.ITextModel): Doc | null {
  const t = tracked.get(model);
  if (!t || !t.session.ready) return null;
  const uri = wireUri(t);
  if (!uri) return null;
  const ensureOwner = () => {
    if (owners.get(t.key) !== model) sendOpen(t);
  };
  return {
    session: t.session,
    uri,
    ensureOwner,
    async request<T>(method: string, params: () => unknown, timeoutMs: number, cancel?: Parameters<LspSession['request']>[3]): Promise<T | null> {
      ensureOwner();
      let r: LspResult<T> = await t.session.request<T>(method, params(), timeoutMs, cancel);
      if ('error' in r && r.error.code === NOT_OWNER) {
        sendOpen(t);
        r = await t.session.request<T>(method, params(), timeoutMs, cancel);
      }
      return 'error' in r ? null : r.result;
    },
  };
}

/** 保存成功時に useFileEntries から呼ぶ。 */
export function notifyDocumentSaved(leafId: string, path: string): void {
  for (const t of tracked.values()) {
    if (t.leafId !== leafId || t.path !== path) continue;
    const uri = wireUri(t);
    if (uri) t.session.notify('textDocument/didSave', { textDocument: { uri } });
    return;
  }
}

/**
 * 定義ジャンプの着地先モデルを事前生成する (peek はモデルが無いとプレビューが空になる —
 * scripts/lsp-spike/RESULTS.md S1)。内容は既存のファイル読み出し API。
 * ponytail: 生成したモデルはタブが開かれなければ残る。数が問題になったら LRU で回収する
 */
export async function ensureModel(leafId: string, path: string, content: () => Promise<string | null>, language: string | undefined): Promise<monaco.editor.ITextModel | null> {
  const uri = monaco.Uri.parse(modelUriString(leafId, path));
  const existing = monaco.editor.getModel(uri);
  if (existing) return existing;
  const text = await content();
  if (text === null) return null;
  return monaco.editor.getModel(uri) ?? monaco.editor.createModel(text, language, uri);
}
