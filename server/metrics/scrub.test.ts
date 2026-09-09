import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { HOOK_EVENTS } from '../hooks.js';
import { Registry, type MetricRecord } from './registry.js';
import { checkAnon, scrubAnon } from './scrub.js';

/**
 * 匿名層の判別器 (閉じた allowlist) の真理値表。
 *
 * 陽性 (落とすべき): 番兵 (パス・リポジトリー名・ブランチ・セッション id・プロンプト・コマンド) を
 * 含むレコードを、実レジストリが生成する形のまま流して、結果が null であることを確認する。
 * 陰性対照 (通すべき): 正当な snapshot / slow / session が無傷で通ることを確認する —
 * 「全部落とす判別器」も陽性側だけなら合格してしまうため。
 */

const SENTINELS = [
  'C:\\Users\\alice\\src\\SecretRepo',
  '/home/alice/work',
  'SecretRepo',
  'feat/TICKET-9',
  'deadbeef',
  'fix login bug',
  'rm -rf .',
  os.homedir(),
  os.userInfo().username,
];

function serialize(record: unknown): string {
  return JSON.stringify(record);
}

/** dev 層のレジストリで、本番の計測点が生成するのと同じ形のレコードを一式作る。 */
function devRecordsWithSentinels(): MetricRecord[] {
  const reg = new Registry({ defaultSlowMs: 0 });
  reg.enabled = true;
  reg.includeAttrs = true;
  const out: MetricRecord[] = [];
  reg.onEvent = (r) => out.push(r);
  reg.recordSpan('git', 800, { git: 'status' }, { cwd: SENTINELS[0], args: 'status --porcelain' });
  reg.recordSpan('http', 300, { route: '/api/git/diff', method: 'GET' }, { status: 200 });
  reg.recordSpan('mirror.snapshot', 200, undefined, { sid: 'deadbeef', title: 'Claude Code' });
  reg.event('session', { kind: 'pty' }, { sid: 'deadbeef', cwd: SENTINELS[1], title: 'SecretRepo' });
  reg.event('hang', { ms: 1500, recent: reg.recentSpans() }, { stack: 'at foo (C:\\Users\\alice\\x.js:1)' });
  reg.event('hook', { hook: 'PreToolUse' }, { command: 'rm -rf .', branch: 'feat/TICKET-9' });
  reg.event('slow', { n: 'sdk.turn', ms: 5000 }, { prompt: 'fix login bug' });
  return out;
}

describe('checkAnon — positive (must drop)', () => {
  it('drops every dev record that carries sentinel attrs', () => {
    const records = devRecordsWithSentinels();
    expect(records.length).toBeGreaterThanOrEqual(7);
    for (const record of records) {
      const text = serialize(record);
      const carries = SENTINELS.some((s) => text.includes(s));
      if (carries) {
        expect(scrubAnon(record), text).toBeNull();
      }
    }
  });

  it.each([
    ['raw URL in route', { k: 'slow', t: 1, n: 'http', route: '/api/git/diff?dir=C%3A%5CUsers%5Calice', method: 'GET', ms: 1 }],
    ['path-like route', { k: 'slow', t: 1, n: 'http', route: '/api/repos/QzpcVXNlcnNcYWxpY2U', method: 'GET', ms: 1 }],
    ['backslash in git label', { k: 'slow', t: 1, n: 'git', git: 'C:\\x', ms: 1 }],
    ['unknown metric name', { k: 'slow', t: 1, n: 'deadbeef', ms: 1 }],
    ['string under a numeric key', { k: 'snapshot', t: 1, proc: { rss: '12 MB' } }],
    ['free-form key with string', { k: 'session', t: 1, kind: 'pty', cwd: '/home/alice/work' }],
    ['string inside array', { k: 'hang', t: 1, ms: 1, recent: ['fix login bug'] }],
    ['string deep inside labels', { k: 'snapshot', t: 1, counters: [{ n: 'http', l: { route: 'C:\\x' }, v: 1 }] }],
    ['label key not in rules', { k: 'snapshot', t: 1, counters: [{ n: 'http', l: { title: 'SecretRepo' }, v: 1 }] }],
    ['non-finite number', { k: 'snapshot', t: 1, proc: { rss: Infinity } }],
    ['NaN', { k: 'snapshot', t: 1, proc: { rss: NaN } }],
    ['bad key characters', { k: 'snapshot', t: 1, 'C:\\Users': 1 }],
    ['run id not 8 hex', { k: 'meta', t: 1, run: 'alice' }],
    ['tab id too long', { k: 'meta', t: 1, tab: 'deadbeefcafe' }],
    ['unknown record kind', { k: 'prompt', t: 1 }],
    ['missing t', { k: 'snapshot' }],
    ['not an object', 'snapshot'],
    ['array top-level', [{ k: 'snapshot', t: 1 }]],
    ['null', null],
    ['too deep', { k: 'snapshot', t: 1, a: { b: { c: { d: { e: 1 } } } } }],
    ['hostname-ish node version', { k: 'meta', t: 1, node: os.hostname() }],
    ['version with path', { k: 'meta', t: 1, version: '0.2.0/C:' }],
    ['status outside vocab', { k: 'session', t: 1, status: 'C:\\x' }],
    ['hook outside vocab', { k: 'hook', t: 1, hook: 'rm -rf .' }],
  ])('drops: %s', (_label, record) => {
    expect(checkAnon(record)).not.toBeNull();
    expect(scrubAnon(record)).toBeNull();
  });
});

describe('checkAnon — negative controls (must pass unchanged)', () => {
  const snapshot = {
    k: 'snapshot',
    t: 1_757_000_000_000,
    run: 'a1b2c3d4',
    src: 'server',
    up: 120,
    proc: {
      rss: 120.5,
      heapUsed: 40.2,
      cpuPct: 1.5,
      elu: 0.02,
      loop: { p50: 0.1, p99: 2.5, max: 12 },
      heap: { used: 40, total: 60, malloced: 1, nativeCtx: 2, detachedCtx: 0 },
      handles: { TCPSocketWrap: 3, Timeout: 4, PipeWrap: 3, ProcessWrap: 1, FSReqPromise: 0 },
    },
    app: { ptySessions: 2, sdkSessions: 1, mirrorLines: 2000, wsEvents: 1 },
    counters: [
      { n: 'pty.flush', v: 100 },
      { n: 'http', l: { route: '/api/git/diff', method: 'GET', sc: '2xx' }, v: 3 },
      { n: 'ws.open', l: { path: '/ws/term' }, v: 2 },
    ],
    gauges: [{ n: 'tiles', v: 3 }, { n: 'js.heap.used', v: null }],
    hist: [{ n: 'git', l: { git: 'status' }, h: { c: 3, sum: 30, min: 5, max: 20, p50: 6.4, p90: 25.6, p99: 20 } }],
  };

  it.each([
    ['snapshot', snapshot],
    ['slow http', { k: 'slow', t: 1, n: 'http', ms: 300, route: '/api/git/diff', method: 'GET' }],
    ['slow http param route', { k: 'slow', t: 1, n: 'http', ms: 300, route: '/api/repos/:id/worktrees', method: 'POST' }],
    ['slow spa', { k: 'slow', t: 1, n: 'http', ms: 300, route: 'spa', method: 'GET' }],
    ['slow git', { k: 'slow', t: 1, n: 'git', ms: 600, git: 'status' }],
    ['slow git other', { k: 'slow', t: 1, n: 'git', ms: 600, git: 'other' }],
    ['session', { k: 'session', t: 1, kind: 'pty', status: 'busy' }],
    ['hang with recent spans', { k: 'hang', t: 1, ms: 1500, recent: [{ n: 'git', t: 1, ph: 's' }, { n: 'git', t: 2, ph: 'e', ms: 900 }] }],
    ['ws phase', { k: 'ws', t: 1, tab: 'cafebabe', path: '/ws/term', phase: 'reconnecting', attempt: 2 }],
    ['meta', { k: 'meta', t: 1, tier: 'anon', version: '0.2.0', node: 'v24.18.1', platform: 'win32', arch: 'x64', pid: 1234 }],
    ['hook event', { k: 'slow', t: 1, n: 'hook.event', ms: 1, hook: HOOK_EVENTS[0] }],
    ['client stall', { k: 'stall', t: 1, tab: '01234567', src: 'client', ms: 300, act: 'active' }],
    ['booleans', { k: 'slow', t: 1, n: 'git', ms: 1, git: 'push', err: true }],
  ])('passes: %s', (_label, record) => {
    expect(checkAnon(record)).toBeNull();
    expect(scrubAnon(record)).toBe(record); // 変換しない (同一参照)
  });

  it('accepts the dev records that carry no attrs once includeAttrs is off (anon registry)', () => {
    const reg = new Registry({ defaultSlowMs: 0 });
    reg.enabled = true; // includeAttrs は false のまま = anon
    const out: MetricRecord[] = [];
    reg.onEvent = (r) => out.push(r);
    reg.recordSpan('git', 800, { git: 'status' }, { cwd: SENTINELS[0] });
    reg.event('session', { kind: 'pty' }, { cwd: SENTINELS[1] });
    expect(out).toHaveLength(2);
    for (const record of out) {
      expect(checkAnon(record)).toBeNull();
      expect(SENTINELS.some((s) => serialize(record).includes(s))).toBe(false);
    }
  });
});
