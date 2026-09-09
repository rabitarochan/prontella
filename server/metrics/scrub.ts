import { STRING_RULES } from './names.js';

/**
 * 匿名層 (anon) のレコード検査。
 *
 * **閉じた allowlist** で判定する: 文字列値を持てるのは names.ts の STRING_RULES にあるキーだけで、
 * 値もその語彙 (または固定形の正規表現) に一致しなければならない。それ以外の値は有限の数値・
 * 真偽値・null に限る。オブジェクト/配列は深さ 4 まで。キー名は英数字のみ。
 *
 * 1 箇所でも違反があればレコード**全体**を落とす (部分的に削って書かない)。判別器が
 * 「パスらしい文字列」を探す blocklist ではなく「許された形以外はすべて拒否」なので、
 * 新しいフィールドの追加漏れは欠測 (記録されない) として現れ、漏洩にはならない。
 *
 * この関数は変換しない (検査のみ)。dev 層はこの検査を通さない。
 */

const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;
const MAX_DEPTH = 4;
const MAX_ARRAY = 256;
const MAX_KEYS = 256;

/** 違反理由 (null = 合格)。テストと self メトリクスの内訳に使う。 */
export function checkAnon(record: unknown): string | null {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return 'not-object';
  const top = record as Record<string, unknown>;
  if (typeof top.k !== 'string') return 'missing-k';
  if (typeof top.t !== 'number' || !Number.isFinite(top.t)) return 'missing-t';
  return checkValue(record, 0, '$');
}

function checkValue(value: unknown, depth: number, where: string): string | null {
  if (value === null) return null;
  switch (typeof value) {
    case 'number':
      return Number.isFinite(value) ? null : `non-finite:${where}`;
    case 'boolean':
      return null;
    case 'string':
      return `string-outside-rules:${where}`;
    case 'object':
      break;
    default:
      return `unsupported-type:${where}`;
  }
  if (depth >= MAX_DEPTH) return `too-deep:${where}`;
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY) return `array-too-long:${where}`;
    for (let i = 0; i < value.length; i++) {
      const reason = checkValue(value[i], depth + 1, `${where}[${i}]`);
      if (reason) return reason;
    }
    return null;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length > MAX_KEYS) return `too-many-keys:${where}`;
  for (const key of keys) {
    if (!KEY_RE.test(key)) return `bad-key:${where}.${key}`;
    const child = obj[key];
    if (typeof child === 'string') {
      const reason = checkString(key, child);
      if (reason) return `${reason}:${where}.${key}`;
      continue;
    }
    const reason = checkValue(child, depth + 1, `${where}.${key}`);
    if (reason) return reason;
  }
  return null;
}

function checkString(key: string, value: string): string | null {
  const rule = STRING_RULES[key];
  if (!rule) return 'string-key-not-allowed';
  if (value.length > 64) return 'string-too-long';
  if ('vocab' in rule) return rule.vocab.has(value) ? null : 'value-outside-vocab';
  return rule.re.test(value) ? null : 'value-outside-pattern';
}

/** 合格したレコードをそのまま返し、不合格なら null。 */
export function scrubAnon<T>(record: T): T | null {
  return checkAnon(record) === null ? record : null;
}
