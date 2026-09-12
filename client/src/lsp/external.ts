import * as monaco from 'monaco-editor';
import { languageFor } from '../monaco-setup';
import type { LspSession } from './session';

/**
 * root 外 (`-ext`) / root 内でエディターの上限 (2MB) を超えるファイルの**読み取り専用モデル**。
 * 定義ジャンプ・参照の着地先として `prontella-ext:` スキームで作り、peek のプレビューと
 * ExternalFileModal (タブにはしない — ファイルタブは root 相対パスが前提) で表示する。
 *
 *   モデル URI  prontella-ext:///<rootToken>-ext/<opaque>/<name>   (ワイヤー URI の scheme を差し替えただけ)
 *               prontella-ext:///<rootToken>/<rel>               (root 内の大きいファイル)
 *
 * - 内容はサーバーの `$/prontella/readExternal` (4MB 上限)。opaque id は LS プロセスの再起動で失効する
 *   → null が返ったら「開けません」(呼び出し側が通知)
 * - 20 件を超えたら古いものから dispose (LRU)。モーダルを閉じても残る
 */

export const EXTERNAL_SCHEME = 'prontella-ext';
const MAX_MODELS = 20;
const READ_TIMEOUT_MS = 10_000;

/** 古い順。既存を使うたびに末尾へ */
const lru: monaco.editor.ITextModel[] = [];
const inflight = new Map<string, Promise<monaco.editor.ITextModel | null>>();

export function externalModelUri(wireUri: string): monaco.Uri {
  return monaco.Uri.parse(`${EXTERNAL_SCHEME}://${wireUri.slice('file://'.length)}`);
}

export function isExternalUri(uri: monaco.Uri): boolean {
  return uri.scheme === EXTERNAL_SCHEME;
}

/** モデル URI → ワイヤー URI (readExternal に渡す形)。 */
export function externalToWire(uri: monaco.Uri): string {
  return `file://${uri.path}`;
}

export async function ensureExternalModel(session: LspSession, wireUri: string): Promise<monaco.editor.ITextModel | null> {
  const uri = externalModelUri(wireUri);
  const existing = monaco.editor.getModel(uri);
  if (existing) {
    touch(existing);
    return existing;
  }
  const key = uri.toString();
  let p = inflight.get(key);
  if (!p) {
    p = (async () => {
      const r = await session.request<{ name: string; text: string }>('$/prontella/readExternal', { uri: wireUri }, READ_TIMEOUT_MS);
      if ('error' in r || !r.result) return null;
      const again = monaco.editor.getModel(uri);
      if (again) return again;
      const model = monaco.editor.createModel(r.result.text, languageFor(r.result.name), uri);
      lru.push(model);
      while (lru.length > MAX_MODELS) lru.shift()!.dispose();
      return model;
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

function touch(model: monaco.editor.ITextModel): void {
  const i = lru.indexOf(model);
  if (i >= 0) {
    lru.splice(i, 1);
    lru.push(model);
  }
}
