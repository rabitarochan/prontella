import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import v8 from 'node:v8';
import type { MetricsTier } from './config.js';
import type { MetricRecord, Registry } from './registry.js';

/**
 * 定期サンプラー。tier ≠ off のときだけ動き、各 tick で 1 行の `snapshot` レコードを出す。
 *
 * 間隔は dev 5 秒 / anon 30 秒。イベントループ遅延の分解能は dev 50ms / anon 100ms —
 * 2026-09-09 の実測 (vt/spike-metrics) で 20ms は CPU 1.4% を食ったが 50ms 以上は測定誤差内。
 * 各項目は個別に try/catch し、サンプラーの失敗が本体に波及しないようにする。
 */

/** マネージャー群から集める値。数値のみ (匿名層でもそのまま通る)。 */
export type AppStats = Record<string, number>;

export interface SamplerOptions {
  registry: Registry;
  tier: Exclude<MetricsTier, 'off'>;
  emit: (record: MetricRecord) => void;
  stats: () => Partial<AppStats>;
  intervalMs?: number;
  loopResolutionMs?: number;
}

export interface SamplerHandle {
  stop(): void;
  /** テスト用: 今すぐ 1 回サンプルして返す (emit もする)。 */
  sampleNow(): MetricRecord;
}

const INTERVAL_MS: Record<Exclude<MetricsTier, 'off'>, number> = { dev: 5_000, anon: 30_000 };
const LOOP_RESOLUTION_MS: Record<Exclude<MetricsTier, 'off'>, number> = { dev: 50, anon: 100 };

const NS_PER_MS = 1e6;
const mb = (bytes: number): number => Math.round((bytes / 1048576) * 100) / 100;
const round2 = (v: number): number => Math.round(v * 100) / 100;

export function startSampler(opts: SamplerOptions): SamplerHandle {
  const { registry, emit } = opts;
  const intervalMs = opts.intervalMs ?? INTERVAL_MS[opts.tier];
  const resolution = opts.loopResolutionMs ?? LOOP_RESOLUTION_MS[opts.tier];

  const loop = monitorEventLoopDelay({ resolution });
  loop.enable();
  let prevCpu = process.cpuUsage();
  let prevWall = performance.now();
  let prevElu = performance.eventLoopUtilization();
  const selfCost = registry.histogram('metrics.self.serialize');

  function sample(): MetricRecord {
    const t0 = performance.now();
    const record: MetricRecord = { k: 'snapshot', t: Date.now(), up: Math.round(process.uptime()) };

    try {
      const mem = process.memoryUsage();
      const cpu = process.cpuUsage(prevCpu);
      prevCpu = process.cpuUsage();
      const wall = performance.now() - prevWall;
      prevWall = performance.now();
      const elu = performance.eventLoopUtilization(prevElu);
      prevElu = performance.eventLoopUtilization();
      const proc: Record<string, unknown> = {
        rss: mb(mem.rss),
        heapUsed: mb(mem.heapUsed),
        heapTotal: mb(mem.heapTotal),
        external: mb(mem.external),
        arrayBuffers: mb(mem.arrayBuffers),
        cpuPct: wall > 0 ? round2(((cpu.user + cpu.system) / 1000 / wall) * 100) : 0,
        elu: round2(elu.utilization),
        // monitorEventLoopDelay の値には分解能ぶんの下駄が乗る (2026-09-09 実測: 300ms の
        // ブロックが resolution 50 で max 348ms、アイドルでも min ≈ resolution)。差し引いて
        // 「余計に待たされた時間」だけを出す。
        loop: {
          p50: round2(Math.max(0, loop.percentile(50) / NS_PER_MS - resolution)),
          p99: round2(Math.max(0, loop.percentile(99) / NS_PER_MS - resolution)),
          max: round2(Math.max(0, loop.max / NS_PER_MS - resolution)),
        },
      };
      loop.reset();
      try {
        const heap = v8.getHeapStatistics();
        proc.heap = {
          used: mb(heap.used_heap_size),
          total: mb(heap.total_heap_size),
          malloced: mb(heap.malloced_memory),
          nativeCtx: heap.number_of_native_contexts,
          detachedCtx: heap.number_of_detached_contexts,
        };
      } catch {
        // v8 統計が取れなくても他は出す
      }
      try {
        const handles: Record<string, number> = {};
        for (const name of process.getActiveResourcesInfo()) handles[name] = (handles[name] ?? 0) + 1;
        proc.handles = handles;
      } catch {
        // 同上
      }
      record.proc = proc;
    } catch {
      // プロセス統計が丸ごと取れない環境でもレコード自体は出す
    }

    try {
      const app: AppStats = {};
      for (const [key, value] of Object.entries(opts.stats())) {
        if (typeof value === 'number' && Number.isFinite(value)) app[key] = value;
      }
      record.app = app;
    } catch {
      record.app = {};
    }

    const snap = registry.snapshot();
    record.counters = snap.counters;
    record.gauges = snap.gauges;
    record.hist = snap.hist;

    emit(record);
    // 直列化 (JSON.stringify) は emit 側で行われるので、ここまでの時間に含まれる
    selfCost.observe(performance.now() - t0);
    return record;
  }

  const timer = setInterval(() => {
    try {
      sample();
    } catch {
      // サンプラーの失敗で本体を止めない
    }
  }, intervalMs);
  timer.unref();

  return {
    stop(): void {
      clearInterval(timer);
      loop.disable();
    },
    sampleNow: sample,
  };
}
