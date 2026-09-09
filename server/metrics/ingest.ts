import { RECORD_KINDS } from './names.js';
import type { MetricRecord } from './registry.js';

/**
 * クライアントから POST されるレコードの受け入れ検査 (pj-untrusted-input)。
 *
 * ここは**形の検査**だけを行う: 種別・時刻・数値の有限性・文字列長・深さ・件数。
 * 匿名層の内容検査 (閉じた allowlist) はこの後の writeRecord → scrub が**サーバーの tier で**
 * 行う — クライアントが自分を dev に昇格させることはできない。`run` / `src` はサーバーが
 * 上書きするので、クライアントが何を送ってきても採用しない。
 */

export const MAX_INGEST_BYTES = 256 * 1024;
export const MAX_INGEST_RECORDS = 500;
const MAX_STRING = 64;
const MAX_DEPTH = 4;
const MAX_ARRAY = 256;
const MAX_KEYS = 128;
const CLOCK_SKEW_MS = 60 * 60 * 1000;
const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;
const KIND_SET: ReadonlySet<string> = new Set(RECORD_KINDS);

function shapeOk(value: unknown, depth: number): boolean {
  if (value === null) return true;
  switch (typeof value) {
    case 'number':
      return Number.isFinite(value);
    case 'boolean':
      return true;
    case 'string':
      return value.length <= MAX_STRING;
    case 'object':
      break;
    default:
      return false;
  }
  if (depth >= MAX_DEPTH) return false;
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY) return false;
    return value.every((v) => shapeOk(v, depth + 1));
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length > MAX_KEYS) return false;
  return keys.every((key) => KEY_RE.test(key) && shapeOk(obj[key], depth + 1));
}

/** 1 件の検査。合格なら run/src を落としたコピーを返し、不合格なら null。 */
export function validateClientRecord(value: unknown, now = Date.now()): MetricRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.k !== 'string' || !KIND_SET.has(rec.k)) return null;
  // meta はサーバーだけが書く
  if (rec.k === 'meta') return null;
  if (typeof rec.t !== 'number' || !Number.isFinite(rec.t) || Math.abs(rec.t - now) > CLOCK_SKEW_MS) return null;
  if (!shapeOk(rec, 0)) return null;
  const { run: _run, src: _src, ...rest } = rec;
  return rest as MetricRecord;
}

export interface IngestResult {
  accepted: number;
  dropped: number;
  /** リクエスト全体を拒否した理由 (400/413 相当)。null なら受理。 */
  rejected: 'too-large' | 'not-array' | 'too-many' | null;
}

export function ingestClientRecords(
  body: unknown,
  contentLength: number | null,
  write: (record: MetricRecord) => boolean,
  now = Date.now(),
): IngestResult {
  if (contentLength !== null && contentLength > MAX_INGEST_BYTES) return { accepted: 0, dropped: 0, rejected: 'too-large' };
  const records = body !== null && typeof body === 'object' ? (body as { records?: unknown }).records : undefined;
  if (!Array.isArray(records)) return { accepted: 0, dropped: 0, rejected: 'not-array' };
  if (records.length > MAX_INGEST_RECORDS) return { accepted: 0, dropped: 0, rejected: 'too-many' };
  let accepted = 0;
  let dropped = 0;
  for (const raw of records) {
    const record = validateClientRecord(raw, now);
    if (record && write(record)) accepted += 1;
    else dropped += 1;
  }
  return { accepted, dropped, rejected: null };
}
