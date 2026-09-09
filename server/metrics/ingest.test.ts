import { describe, expect, it } from 'vitest';
import { MAX_INGEST_BYTES, ingestClientRecords, validateClientRecord } from './ingest.js';
import type { MetricRecord } from './registry.js';
import { checkAnon } from './scrub.js';

const NOW = 1_757_000_000_000;

describe('validateClientRecord', () => {
  it('accepts a well-formed snapshot and strips run/src', () => {
    const rec = validateClientRecord(
      { k: 'snapshot', t: NOW, tab: 'cafebabe', run: 'attacker', src: 'server', counters: [{ n: 'xterm.instances', v: 2 }] },
      NOW,
    );
    expect(rec).toEqual({ k: 'snapshot', t: NOW, tab: 'cafebabe', counters: [{ n: 'xterm.instances', v: 2 }] });
  });

  it.each([
    ['null', null],
    ['array', [{ k: 'snapshot', t: NOW }]],
    ['unknown kind', { k: 'prompt', t: NOW }],
    ['meta from client', { k: 'meta', t: NOW }],
    ['missing t', { k: 'snapshot' }],
    ['t too old', { k: 'snapshot', t: NOW - 2 * 60 * 60 * 1000 }],
    ['t in the future', { k: 'snapshot', t: NOW + 2 * 60 * 60 * 1000 }],
    ['NaN number', { k: 'snapshot', t: NOW, v: NaN }],
    ['Infinity', { k: 'snapshot', t: NOW, v: Infinity }],
    ['long string', { k: 'slow', t: NOW, n: 'x'.repeat(65) }],
    ['bad key', { k: 'snapshot', t: NOW, 'a b': 1 }],
    ['too deep', { k: 'snapshot', t: NOW, a: { b: { c: { d: { e: 1 } } } } }],
    ['function', { k: 'snapshot', t: NOW, f: () => 1 }],
    ['huge array', { k: 'snapshot', t: NOW, a: new Array(257).fill(1) }],
  ])('rejects: %s', (_label, value) => {
    expect(validateClientRecord(value, NOW)).toBeNull();
  });

  it('shape-accepts path-like strings (content is the scrub stage, per server tier)', () => {
    // 形の検査は内容を見ない。anon では後段の checkAnon が落とし、dev ではそのまま残る。
    const rec = validateClientRecord({ k: 'slow', t: NOW, n: 'http', route: 'C:\\Users\\alice', ms: 1 }, NOW);
    expect(rec).not.toBeNull();
    expect(checkAnon({ ...rec, run: 'a1b2c3d4', src: 'client' })).not.toBeNull();
  });
});

describe('ingestClientRecords', () => {
  const collect = () => {
    const written: MetricRecord[] = [];
    return { written, write: (r: MetricRecord) => (written.push(r), true) };
  };

  it('rejects oversize bodies before looking at them', () => {
    const { write } = collect();
    expect(ingestClientRecords({ records: [] }, MAX_INGEST_BYTES + 1, write, NOW)).toEqual({
      accepted: 0,
      dropped: 0,
      rejected: 'too-large',
    });
  });

  it.each([
    ['null body', null],
    ['string body', 'records'],
    ['records not array', { records: { k: 'snapshot' } }],
    ['records missing', {}],
    ['array body', [{ k: 'snapshot', t: NOW }]],
  ])('rejects: %s', (_label, body) => {
    const { write } = collect();
    expect(ingestClientRecords(body, 100, write, NOW).rejected).toBe('not-array');
  });

  it('rejects more than 500 records', () => {
    const { write } = collect();
    const records = new Array(501).fill({ k: 'snapshot', t: NOW });
    expect(ingestClientRecords({ records }, 100, write, NOW).rejected).toBe('too-many');
  });

  it('accepts valid records, drops invalid ones, and counts what the writer refuses', () => {
    const written: MetricRecord[] = [];
    const write = (r: MetricRecord) => {
      if (r.k === 'stall') return false; // scrub 側で落ちた想定
      written.push(r);
      return true;
    };
    const result = ingestClientRecords(
      {
        records: [
          { k: 'snapshot', t: NOW, tab: 'cafebabe' },
          { k: 'bogus', t: NOW },
          { k: 'stall', t: NOW, ms: 300 },
          { k: 'slow', t: NOW, n: 'http', ms: 300, route: '/api/git/diff', method: 'GET' },
        ],
      },
      null,
      write,
      NOW,
    );
    expect(result).toEqual({ accepted: 2, dropped: 2, rejected: null });
    expect(written.map((r) => r.k)).toEqual(['snapshot', 'slow']);
  });
});
