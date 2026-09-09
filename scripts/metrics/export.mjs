#!/usr/bin/env node
// Bundle the anonymous metrics (anon/*.jsonl) into one gzip file for attaching to a bug report.
//
//   node scripts/metrics/export.mjs [--dir <path>] [--out prontella-diagnostics-<date>.jsonl.gz]
//
// The bundle starts with a `meta` line carrying only version / platform / arch / node — no hostname,
// no user name, no paths. The anon records themselves were already filtered by the server's closed
// allowlist when written (server/metrics/scrub.ts); this script does not add anything to them.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { defaultMetricsDir } from './summarize.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--dir': out.dir = next(); break;
      case '--out': out.out = next(); break;
      case '-h': case '--help': out.help = true; break;
      default: throw new Error(`unknown option: ${a}`);
    }
  }
  return out;
}

export function bundleMetaLine() {
  let version = null;
  try {
    version = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'package.json'), 'utf8')).version ?? null;
  } catch {
    // 配布物では package.json の位置が違うことがある — version 無しで続行
  }
  const platform = ['win32', 'linux', 'darwin'].includes(process.platform) ? process.platform : 'other';
  const arch = ['x64', 'arm64'].includes(process.arch) ? process.arch : 'other';
  return JSON.stringify({ k: 'meta', t: Date.now(), bundle: 1, ...(version ? { version } : {}), node: process.version, platform, arch });
}

export function buildBundle(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
  const parts = [bundleMetaLine() + '\n'];
  let lines = 0;
  for (const file of files) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      parts.push(line + '\n');
      lines += 1;
    }
  }
  return { gz: zlib.gzipSync(Buffer.from(parts.join(''), 'utf8')), files: files.length, lines };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: export.mjs [--dir <path>] [--out <file.jsonl.gz>]');
    return;
  }
  const dir = args.dir ?? defaultMetricsDir('anon');
  if (!fs.existsSync(dir)) {
    console.error(`no anonymous metrics directory: ${dir}`);
    process.exitCode = 1;
    return;
  }
  const { gz, files, lines } = buildBundle(dir);
  const out = args.out ?? `prontella-diagnostics-${new Date().toISOString().slice(0, 10)}.jsonl.gz`;
  fs.writeFileSync(out, gz);
  console.error(`wrote ${out}: ${lines} records from ${files} files, ${gz.length} bytes gzipped`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
