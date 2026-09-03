#!/usr/bin/env node
// node scripts/bench/compare.mjs results/a.json results/b.json
// a = before, b = after. Prints a Markdown table of the diff for the main metrics.
import fs from 'node:fs';

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

const METRICS = [
  ['m1.attachMs', 'M1 attach (ms)', 'lower'],
  ['m1.snapshotBytes', 'M1 snapshot bytes', 'lower'],
  ['m1.longtaskMs', 'M1 longtask ms', 'lower'],
  ['m1.perf.TaskDuration', 'M1 TaskDuration diff (s)', 'lower'],
  ['m2.serverCpuSecondsPerWallSecond', 'M2 server CPU/wall', 'lower'],
  ['m2.serverRssBytesAfter', 'M2 server RSS after', 'lower'],
  ['m2.pageA.longtaskMs', 'M2 pageA longtask ms', 'lower'],
  ['m2.pageB.longtaskMs', 'M2 pageB longtask ms', 'lower'],
  ['m2.pageA.wsBytesReceived', 'M2 pageA ws bytes recv', 'lower'],
  ['m2.pageB.wsBytesReceived', 'M2 pageB ws bytes recv', 'lower'],
  ['m3.dragMs', 'M3 drag (ms)', 'lower'],
  ['m3.resizeFramesSentByDriver', 'M3 resize sent(driver)', 'lower'],
  ['m3.resizeFramesReceivedByOther', 'M3 resize recv(other)', 'lower'],
  ['m3.serverCpuSecondsPerWallSecond', 'M3 server CPU/wall (drag)', 'lower'],
  ['m3.driverLongtaskMs', 'M3 driver longtask ms', 'lower'],
  ['m4.reconnectMs', 'M4 reconnect (ms)', 'lower'],
  ['m4.longtaskMs', 'M4 longtask ms', 'lower'],
];

function fmt(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return 'n/a';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3);
  return String(v);
}

function main() {
  const [fileA, fileB] = process.argv.slice(2);
  if (!fileA || !fileB) {
    console.error('usage: node scripts/bench/compare.mjs results/a.json results/b.json');
    process.exit(1);
  }
  const a = JSON.parse(fs.readFileSync(fileA, 'utf8'));
  const b = JSON.parse(fs.readFileSync(fileB, 'utf8'));

  console.log(`\n## compare: ${a.label} (${a.at}) -> ${b.label} (${b.at})\n`);
  console.log('| metric | before | after | delta | delta % |');
  console.log('| --- | --- | --- | --- | --- |');
  for (const [dotted, label] of METRICS) {
    const va = getPath(a, dotted);
    const vb = getPath(b, dotted);
    let delta = 'n/a';
    let pct = 'n/a';
    if (typeof va === 'number' && typeof vb === 'number' && !Number.isNaN(va) && !Number.isNaN(vb)) {
      const d = vb - va;
      delta = (d >= 0 ? '+' : '') + fmt(d);
      pct = va !== 0 ? `${d >= 0 ? '+' : ''}${((d / va) * 100).toFixed(1)}%` : 'n/a';
    }
    console.log(`| ${label} | ${fmt(va)} | ${fmt(vb)} | ${delta} | ${pct} |`);
  }
  console.log('');
}

main();
