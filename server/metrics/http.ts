import { performance } from 'node:perf_hooks';
import type express from 'express';
import { HTTP_METHODS, statusClass } from './names.js';
import type { Registry } from './registry.js';

/**
 * HTTP ルートの計測。
 *
 * **express.json より前**に置く: 後ろに置くと body-parser が投げるエラー (413 等) は
 * このミドルウェアに到達せず観測できない (2026-09-09 実測、vt/spike-metrics/spike-e.mjs)。
 * ルート名は `req.route.path` (ソースコード上のテンプレート、例 `/api/repos/:id`) だけを使い、
 * `req.url` は**絶対に**記録しない (クエリにパスやリポジトリー名が入る)。
 */

const METHOD_SET: ReadonlySet<string> = new Set(HTTP_METHODS);

/**
 * `req.route.path` を匿名層でも通る形に正規化する。
 * - 文字列テンプレート → そのまま
 * - RegExp ルート (SPA フォールバック) → 'spa'
 * - ルート未確定 (404 や express.static が処理したもの) → /api 配下なら 'unmatched'、それ以外 'static'
 */
export function routeLabel(req: { route?: unknown; path?: string }): string {
  const route = req.route as { path?: unknown } | undefined;
  if (route && typeof route.path === 'string') return route.path;
  if (route) return 'spa';
  return typeof req.path === 'string' && req.path.startsWith('/api') ? 'unmatched' : 'static';
}

export function methodLabel(method: string): string {
  return METHOD_SET.has(method) ? method : 'OPTIONS';
}

export function httpMetricsMiddleware(registry: Registry): express.RequestHandler {
  return (req, res, next) => {
    if (!registry.enabled) {
      next();
      return;
    }
    const t0 = performance.now();
    res.on('finish', () => {
      const ms = performance.now() - t0;
      const labels = { route: routeLabel(req), method: methodLabel(req.method) };
      registry.count('http', 1, { ...labels, sc: statusClass(res.statusCode) });
      registry.recordSpan('http', ms, labels, { status: res.statusCode });
    });
    next();
  };
}
