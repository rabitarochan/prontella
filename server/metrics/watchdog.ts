import { Worker } from 'node:worker_threads';
import type { Registry } from './registry.js';

/**
 * メインスレッドのブロック検知 (dev 層のみ)。
 *
 * `monitorEventLoopDelay` はブロックが**終わってから**分布に現れる。こちらは別スレッドの Worker が
 * SharedArrayBuffer の心拍 (メインが 250ms ごとに加算) を 500ms ごとに見て、1 秒以上止まったら
 * 停止時間を記録し、メインが復帰した時点で `hang` イベント (直近 span 付き) を出す。
 * Worker は存在するだけで CPU 約 0.4% (2026-09-09 実測) なので anon では動かさない。
 *
 * Worker のソースは文字列で埋め込む (`eval: true`) — tsx 実行時 (.ts) と dist (.js) でパスが
 * 変わる問題を避けるため。
 */

const HEARTBEAT_MS = 250;
const CHECK_MS = 500;
const STALL_MS = 1_000;

const WORKER_SOURCE = `
const { workerData, parentPort } = require('node:worker_threads');
const view = new Int32Array(workerData.sab);
const stallMs = workerData.stallMs;
let last = Atomics.load(view, 0);
let staleSince = null;
setInterval(() => {
  const v = Atomics.load(view, 0);
  const now = Date.now();
  if (v === last) {
    if (staleSince === null) staleSince = now;
    return;
  }
  last = v;
  if (staleSince !== null) {
    const stalled = now - staleSince;
    staleSince = null;
    if (stalled >= stallMs) parentPort.postMessage({ stalledMs: stalled });
  }
}, workerData.checkMs);
`;

export interface Watchdog {
  stop(): void;
}

export function startWatchdog(registry: Registry, opts: { stallMs?: number; heartbeatMs?: number; checkMs?: number } = {}): Watchdog | null {
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  let worker: Worker;
  try {
    worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { sab, stallMs: opts.stallMs ?? STALL_MS, checkMs: opts.checkMs ?? CHECK_MS },
    });
  } catch {
    return null;
  }
  worker.unref();
  worker.on('error', () => {
    // 監視側の失敗で本体を止めない
  });
  worker.on('message', (msg: { stalledMs?: number }) => {
    if (typeof msg?.stalledMs !== 'number') return;
    // 最後の心拍から復帰までなので、実際のブロック時間は心拍間隔ぶん短い可能性がある
    registry.event('hang', { ms: Math.round(msg.stalledMs), recent: registry.recentSpans() });
  });
  const beat = setInterval(() => Atomics.add(view, 0, 1), opts.heartbeatMs ?? HEARTBEAT_MS);
  beat.unref();
  return {
    stop(): void {
      clearInterval(beat);
      void worker.terminate();
    },
  };
}
