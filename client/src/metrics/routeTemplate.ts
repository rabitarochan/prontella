/**
 * fetch した URL をルートテンプレート (`/api/repos/:id/branches`) に潰す純関数。
 *
 * クエリ文字列 (dir=C:\... 等のパスが入る) は必ず捨てる。`/api/repos/<base64url>` と
 * `/api/terminals/<id>` `/api/agents/resumable/<id>` の可変セグメントは `:id` に置換する。
 * サーバー側の匿名スクラブは閉じたルート語彙で検査するので、ここで潰し損ねた URL は
 * 記録されずに落ちる (漏洩ではなく欠測になる)。
 */

/** 可変セグメントを持つプレフィックス。この直後の 1 セグメントを :id にする。 */
const ID_AFTER = ['/api/repos', '/api/terminals', '/api/agents/resumable'] as const;
/** `/api/repos/order` のように、可変に見えて固定のセグメント。 */
const FIXED_AFTER_REPOS = new Set(['order']);

export function routeTemplate(url: string): string {
  let path = url;
  const q = path.indexOf('?');
  if (q >= 0) path = path.slice(0, q);
  const hash = path.indexOf('#');
  if (hash >= 0) path = path.slice(0, hash);
  // 絶対 URL が来ても pathname だけ見る
  if (/^[a-z]+:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      return 'unmatched';
    }
  }
  if (!path.startsWith('/api/')) return 'unmatched';
  const segments = path.split('/').filter((s) => s !== '');
  const out: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const prefix = '/' + segments.slice(0, i).join('/');
    const seg = segments[i];
    const variable =
      (ID_AFTER as readonly string[]).includes(prefix) && !(prefix === '/api/repos' && FIXED_AFTER_REPOS.has(seg));
    out.push(variable ? ':id' : seg);
  }
  return '/' + out.join('/');
}
