/**
 * Monaco のモデル URI とワイヤー (サーバー) の URI の変換。純関数。
 *
 *   モデル   file:///<leafId>/<rel>      (useFileEntries.modelPath = `${leafId}/${path}` を Uri.parse したもの)
 *   ワイヤー file:///<rootToken>/<rel>   (サーバーが root ごとに払い出す不透明トークン)
 *   root 外  file:///<rootToken>-ext/<opaque>/<name>   → 開けない (MVP では中身を読む API を作らない)
 *
 * 変換は第 1 セグメントの入れ替えだけ。競合解決ペインの `${leafId}-conflict/...` は
 * 第 1 セグメント完全一致で自然に除外される (useGitGutter と同じ判定)。
 */

export interface ModelRef {
  leafId: string;
  /** root 相対 (スラッシュ区切り、デコード済み) */
  path: string;
}

/** `file:///<leaf>/<rel>` 形の URI 文字列から leafId と path を取り出す。 */
export function parseModelUri(uriString: string): ModelRef | null {
  const m = /^file:\/\/\/([^/]+)\/(.+)$/.exec(uriString);
  if (!m) return null;
  const leafId = safeDecode(m[1]!);
  const segs = m[2]!.split('/').map(safeDecode);
  if (leafId === null || segs.some((s) => s === null || s === '')) return null;
  return { leafId, path: (segs as string[]).join('/') };
}

export function modelUriString(leafId: string, path: string): string {
  return `file:///${encodeURIComponent(leafId)}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

export function toWireUri(rootToken: string, path: string): string {
  return `file:///${rootToken}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

export type WireRef = { kind: 'file'; path: string } | { kind: 'external'; name: string };

/** ワイヤー URI を解釈する。トークンが違えば null。 */
export function parseWireUri(rootToken: string, uriString: string): WireRef | null {
  const filePrefix = `file:///${rootToken}/`;
  if (uriString.startsWith(filePrefix)) {
    const segs = uriString.slice(filePrefix.length).split('/');
    if (segs.some((s) => s === '')) return null;
    const decoded = segs.map(safeDecode);
    if (decoded.some((s) => s === null)) return null;
    return { kind: 'file', path: (decoded as string[]).join('/') };
  }
  const extPrefix = `file:///${rootToken}-ext/`;
  if (uriString.startsWith(extPrefix)) {
    const name = uriString.slice(extPrefix.length).split('/').pop() ?? '';
    return { kind: 'external', name: safeDecode(name) ?? name };
  }
  return null;
}

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}
