#!/usr/bin/env node
// Summarize Prontella metrics JSONL into a Markdown report an AI agent (or a human) can read.
//
//   node scripts/metrics/summarize.mjs [--dir <path>] [--tier dev|anon] [--since 2h|2026-09-08]
//                                      [--top 15] [--run <id>] [--out summary.md]
//
// Default dir: %USERPROFILE%/.prontella/metrics/<tier> (falls back to the legacy .claude-deck3 dir).
// Dependency-free Node ESM; streams every *.jsonl in the directory (truncated last lines are tolerated).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyze, parseJsonl, parseSince } from './lib/analyze.mjs';
import { renderMarkdown } from './lib/report.mjs';

function parseArgs(argv) {
  const out = { tier: 'dev', top: 15 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--dir': out.dir = next(); break;
      case '--tier': out.tier = next(); break;
      case '--since': out.since = next(); break;
      case '--top': out.top = Number(next()); break;
      case '--run': out.run = next(); break;
      case '--out': out.out = next(); break;
      case '-h': case '--help': out.help = true; break;
      default: throw new Error(`unknown option: ${a}`);
    }
  }
  if (out.tier !== 'dev' && out.tier !== 'anon') throw new Error('--tier は dev か anon');
  return out;
}

export function defaultMetricsDir(tier) {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const next = path.join(home, '.prontella', 'metrics', tier);
  if (fs.existsSync(next)) return next;
  const legacy = path.join(home, '.claude-deck3', 'metrics', tier);
  return fs.existsSync(legacy) ? legacy : next;
}

export function loadRecords(dir, { since = null, run = null } = {}) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
  } catch {
    return { records: [], bad: 0, files: 0 };
  }
  const records = [];
  let bad = 0;
  for (const file of files) {
    const parsed = parseJsonl(fs.readFileSync(path.join(dir, file), 'utf8'));
    bad += parsed.bad;
    for (const r of parsed.records) {
      if (since !== null && r.t < since) continue;
      if (run !== null && r.run !== run) continue;
      records.push(r);
    }
  }
  records.sort((a, b) => a.t - b.t);
  return { records, bad, files: files.length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: summarize.mjs [--dir <path>] [--tier dev|anon] [--since 2h] [--top 15] [--run <id>] [--out file.md]');
    return;
  }
  const dir = args.dir ?? defaultMetricsDir(args.tier);
  const { records, bad, files } = loadRecords(dir, { since: parseSince(args.since), run: args.run ?? null });
  if (records.length === 0) {
    console.error(`no records under ${dir} (tier=${args.tier}). Enable with PRONTELLA_METRICS=${args.tier} or config.json metrics.tier.`);
    process.exitCode = 1;
    return;
  }
  const runs = analyze(records, { top: args.top });
  const md = renderMarkdown(runs, { tier: args.tier, dir, bad, files });
  if (args.out) {
    fs.writeFileSync(args.out, md, 'utf8');
    console.error(`wrote ${args.out} (${records.length} records, ${runs.length} runs)`);
  } else {
    process.stdout.write(md);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
