import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { safeResolve } from '../files.js';

/**
 * 言語サーバーとクライアントの間で URI を書き換える純関数群。
 *
 * ディスク上 (LS 側)     file:///C:/Users/.../repo/src/a.ts
 * ワイヤー (クライアント) file:///<rootToken>/src/a.ts
 *
 * クライアントには実パスを一切出さない。root 外 (グローバル TS の lib.d.ts 等) は
 * `file:///<rootToken>-ext/<opaque>` に置き換え、opaque → 絶対パスの表はセッションが持つ。
 * クライアントから絶対パスを受け取る経路は作らない — 逆変換は表の引きだけ。
 */

export interface ExtTable {
  /** root 外の絶対パス → opaque id。無ければ採番する。 */
  toOpaque(abs: string): string;
  /** opaque id → 絶対パス。未知なら undefined。 */
  fromOpaque(id: string): string | undefined;
}

export function createExtTable(): ExtTable {
  const byPath = new Map<string, string>();
  const byId = new Map<string, string>();
  return {
    toOpaque(abs) {
      const key = normalizeForCompare(abs);
      let id = byPath.get(key);
      if (id === undefined) {
        id = `e${byPath.size + 1}`;
        byPath.set(key, id);
        byId.set(id, abs);
      }
      return id;
    },
    fromOpaque(id) {
      return byId.get(id);
    },
  };
}

function normalizeForCompare(abs: string): string {
  const resolved = path.resolve(abs);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** root からの相対パス (スラッシュ区切り) を LS 向けの file URI にする。root 外は投げる。 */
export function docToUri(root: string, rel: string): string {
  return pathToFileURL(safeResolve(root, rel)).href;
}

/** file URI の root 相対パスを返す (root 外なら null)。 */
function relUnderRoot(root: string, uri: string): string | null {
  let abs: string;
  try {
    abs = fileURLToPath(uri);
  } catch {
    return null;
  }
  const rootAbs = normalizeForCompare(root);
  const absN = normalizeForCompare(abs);
  if (absN === rootAbs) return '';
  if (!absN.startsWith(rootAbs + path.sep)) return null;
  return path.resolve(abs).slice(rootAbs.length + 1).split(path.sep).join('/');
}

/** LS から来た file URI → ワイヤー形式。 */
export function uriToWire(root: string, rootToken: string, ext: ExtTable, uri: string): string {
  if (!uri.startsWith('file:')) return uri;
  const rel = relUnderRoot(root, uri);
  if (rel !== null) return `file:///${rootToken}/${encodeRel(rel)}`;
  let abs: string;
  try {
    abs = fileURLToPath(uri);
  } catch {
    return uri;
  }
  const name = encodeURIComponent(path.basename(abs));
  return `file:///${rootToken}-ext/${ext.toOpaque(abs)}/${name}`;
}

/** ワイヤー形式 → LS 向け file URI。解釈できなければ null (呼び出し側は要求を拒否する)。 */
export function wireToUri(root: string, rootToken: string, ext: ExtTable, wire: string): string | null {
  const prefix = `file:///${rootToken}/`;
  if (wire.startsWith(prefix)) {
    const rel = decodeRel(wire.slice(prefix.length));
    if (rel === null) return null;
    try {
      return docToUri(root, rel);
    } catch {
      return null;
    }
  }
  const extPrefix = `file:///${rootToken}-ext/`;
  if (wire.startsWith(extPrefix)) {
    const id = wire.slice(extPrefix.length).split('/')[0];
    const abs = ext.fromOpaque(id);
    return abs === undefined ? null : pathToFileURL(abs).href;
  }
  return null;
}

function encodeRel(rel: string): string {
  return rel.split('/').map(encodeURIComponent).join('/');
}

function decodeRel(encoded: string): string | null {
  try {
    const rel = encoded.split('/').map(decodeURIComponent).join('/');
    // 空セグメント・`.`・`..` は safeResolve 以前に弾く (`a//b` や末尾スラッシュも含む)
    if (rel.split('/').some((s) => s === '' || s === '.' || s === '..')) return null;
    return rel;
  } catch {
    return null;
  }
}

/**
 * JSON 値を深く走査して、`file://` で始まる文字列値と**オブジェクトのキー**を書き換える
 * (`WorkspaceEdit.changes` は URI をキーにする)。fn が null を返した値は undefined に落とす。
 */
export function rewriteUris(value: unknown, fn: (uri: string) => string | null): unknown {
  if (typeof value === 'string') {
    if (!value.startsWith('file:')) return value;
    return fn(value) ?? undefined;
  }
  if (Array.isArray(value)) return value.map((v) => rewriteUris(v, fn));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const key = k.startsWith('file:') ? fn(k) : k;
      if (key === null) continue;
      out[key] = rewriteUris(v, fn);
    }
    return out;
  }
  return value;
}
