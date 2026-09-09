import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { metricsDir } from './config.js';
import { archLabel, platformLabel } from './names.js';

/**
 * 匿名メトリクスの診断バンドル (`anon/*.jsonl` を 1 つの gzip に連結)。
 *
 * 先頭に `meta` 行 (version / node / platform / arch のみ。ホスト名・ユーザー名・パスは無い) を置く。
 * 中身の匿名性は書き込み時の scrub が担保済みで、ここでは何も足さない・変えない。
 * scripts/metrics/export.mjs と同じ形式 (サーバーが動いていなくても CLI で作れるよう、意図的に複製)。
 */
export function buildAnonBundle(version: string | null, dir = metricsDir('anon')): { gz: Buffer; files: number; lines: number } {
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
  } catch {
    files = [];
  }
  const meta = {
    k: 'meta',
    t: Date.now(),
    bundle: 1,
    ...(version ? { version } : {}),
    node: process.version,
    platform: platformLabel(process.platform),
    arch: archLabel(process.arch),
  };
  const parts: string[] = [JSON.stringify(meta) + '\n'];
  let lines = 0;
  for (const file of files) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      parts.push(line + '\n');
      lines += 1;
    }
  }
  return { gz: zlib.gzipSync(Buffer.from(parts.join(''), 'utf8')), files: files.length, lines };
}

export function bundleFileName(now = new Date()): string {
  return `prontella-diagnostics-${now.toISOString().slice(0, 10)}.jsonl.gz`;
}
