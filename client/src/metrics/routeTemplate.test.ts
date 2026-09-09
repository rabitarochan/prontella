import { describe, expect, it } from 'vitest';
import { routeTemplate } from './routeTemplate.js';

// client/src/api.ts が実際に組み立てる URL の形 (クエリにパスが入るもの、id を含むもの) を
// 一覧にして、テンプレートにクエリも id も残らないことを固定する。
describe('routeTemplate', () => {
  const cases: [url: string, expected: string][] = [
    ['/api/repos', '/api/repos'],
    ['/api/repos/order', '/api/repos/order'],
    ['/api/repos/QzpcVXNlcnNcYWxpY2VcU2VjcmV0UmVwbw', '/api/repos/:id'],
    ['/api/repos/QzpcVXNlcnNcYWxpY2U/branches', '/api/repos/:id/branches'],
    ['/api/repos/QzpcVXNlcnNcYWxpY2U/worktrees?path=C%3A%5Cwt&force=1', '/api/repos/:id/worktrees'],
    ['/api/terminals', '/api/terminals'],
    ['/api/terminals?cwd=C%3A%5CUsers%5Calice', '/api/terminals'],
    ['/api/terminals/deadbeef/kill', '/api/terminals/:id/kill'],
    ['/api/agents/resumable', '/api/agents/resumable'],
    ['/api/agents/resumable?cwd=%2Fhome%2Falice', '/api/agents/resumable'],
    ['/api/agents/resumable/0f1e2d3c-1111-2222-3333-444455556666/discard', '/api/agents/resumable/:id/discard'],
    ['/api/git/status?dir=C%3A%5CUsers%5Calice%5Csrc%5CSecretRepo', '/api/git/status'],
    ['/api/git/diff?dir=C%3A%5Cx&path=secret.ts&scope=worktree', '/api/git/diff'],
    ['/api/git/log?dir=%2Fhome%2Falice&ref=feat%2FTICKET-9', '/api/git/log'],
    ['/api/fs/file?root=C%3A%5Cx&path=README.md', '/api/fs/file'],
    ['/api/search/text?root=C%3A%5Cx&q=password', '/api/search/text'],
    ['/api/usage', '/api/usage'],
    ['/api/metrics/config', '/api/metrics/config'],
    ['http://localhost:3711/api/git/status?dir=C%3A%5Cx', '/api/git/status'],
    ['/api/git/status#frag', '/api/git/status'],
    ['/not-api', 'unmatched'],
    ['', 'unmatched'],
  ];

  it.each(cases)('%s → %s', (url, expected) => {
    const template = routeTemplate(url);
    expect(template).toBe(expected);
    expect(template).not.toContain('?');
    expect(template).not.toMatch(/[A-Za-z0-9_-]{20,}/);
  });
});
