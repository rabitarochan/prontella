import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GIT_SUBCOMMANDS, METRIC_NAMES, ROUTES, STRING_RULES, gitSubcommand, statusClass } from './names.js';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('ROUTES stays in sync with server/index.ts', () => {
  it('lists exactly the /api templates registered with app.<method>(...)', () => {
    // index.ts は import すると実サーバーを bind するので、ソースをテキストとして読む。
    const source = fs.readFileSync(path.join(here, '..', 'index.ts'), 'utf8');
    const registered = new Set<string>();
    for (const m of source.matchAll(/app\.(?:get|post|put|patch|delete)\(\s*'(\/api\/[^']+)'/g)) {
      registered.add(m[1]);
    }
    expect(registered.size).toBeGreaterThan(50);
    const listed = new Set(ROUTES.filter((r) => r.startsWith('/')));
    expect([...registered].filter((r) => !listed.has(r)), 'index.ts にあって ROUTES に無い').toEqual([]);
    expect([...listed].filter((r) => !registered.has(r)), 'ROUTES にあって index.ts に無い').toEqual([]);
  });

  it('keeps only the three fixed classifications as non-path entries', () => {
    expect(ROUTES.filter((r) => !r.startsWith('/'))).toEqual(['spa', 'static', 'unmatched']);
  });
});

describe('vocabularies', () => {
  it('metric names are unique and shaped like identifiers', () => {
    expect(new Set(METRIC_NAMES).size).toBe(METRIC_NAMES.length);
    for (const n of METRIC_NAMES) expect(n).toMatch(/^[a-z][a-zA-Z0-9.]*$/);
  });

  it('every string rule key is a plain identifier', () => {
    for (const key of Object.keys(STRING_RULES)) expect(key).toMatch(/^[a-z][A-Za-z0-9]*$/);
  });

  it('gitSubcommand skips -c/-C values and options, and collapses unknowns', () => {
    expect(gitSubcommand(['-c', 'core.quotepath=false', 'status', '--porcelain'])).toBe('status');
    expect(gitSubcommand(['-C', 'C:\\repo', '--no-pager', 'log'])).toBe('log');
    expect(gitSubcommand(['-c', 'x=y', 'C:\\evil'])).toBe('other');
    expect(gitSubcommand(['--version'])).toBe('other');
    expect(gitSubcommand([])).toBe('other');
    expect(GIT_SUBCOMMANDS).toContain('other');
  });

  it('statusClass buckets by hundreds', () => {
    expect([100, 204, 304, 404, 500, 599].map(statusClass)).toEqual(['1xx', '2xx', '3xx', '4xx', '5xx', '5xx']);
  });
});
