import { describe, expect, it } from 'vitest';
import { methodLabel, routeLabel } from './http.js';

// 2026-09-09 実測 (vt/spike-metrics/spike-e.mjs) の Express 5 の req.route の形を固定する:
// 文字列テンプレート / RegExp (SPA フォールバック) / 未確定 (404・static)。
describe('routeLabel', () => {
  it('uses the route template, never the URL', () => {
    expect(routeLabel({ route: { path: '/api/repos/:id' }, path: '/api/repos/QzpcVXNlcnM' })).toBe('/api/repos/:id');
    expect(routeLabel({ route: { path: '/api/git/diff' }, path: '/api/git/diff' })).toBe('/api/git/diff');
  });

  it('maps RegExp routes to spa', () => {
    expect(routeLabel({ route: { path: /^\/(?!api|ws).*/ }, path: '/some/page' })).toBe('spa');
  });

  it('classifies unmatched requests by prefix without recording the path', () => {
    expect(routeLabel({ path: '/api/nothing-here' })).toBe('unmatched');
    expect(routeLabel({ path: '/assets/index-abc.js' })).toBe('static');
    expect(routeLabel({})).toBe('static');
  });
});

describe('methodLabel', () => {
  it('collapses unknown methods into OPTIONS', () => {
    expect(methodLabel('GET')).toBe('GET');
    expect(methodLabel('PROPFIND')).toBe('OPTIONS');
  });
});
