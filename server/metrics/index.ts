import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadMetricsConfig,
  metricsDir,
  setConfiguredTier,
  type MetricsConfig,
  type MetricsTier,
} from './config.js';
import { archLabel, platformLabel } from './names.js';
import { Registry, type MetricRecord } from './registry.js';
import { startSampler, type AppStats, type SamplerHandle } from './sampler.js';
import { checkAnon } from './scrub.js';
import { createJsonlSink, type Sink, type SinkStats } from './sink.js';

/**
 * メトリクスの合成ルート。
 *
 * レジストリはモジュール読み込み時に 1 つだけ作る (タイマー・ファイルは持たない)。計測点は
 * `metrics.counter(...)` 等のハンドルを閉じ込めてよく、tier の切替でハンドルは無効にならない
 * (切替はレジストリの enabled と、その先の sink / sampler だけを差し替える)。
 *
 * `initMetrics()` を呼ぶまでは何も起きない。tier が off なら呼んでも何も起きない。
 */

export const metrics = new Registry({
  slowMs: {
    http: 250,
    git: 500,
    'mirror.snapshot': 100,
    'pty.scan': 5,
    'sdk.turn': 120_000,
    'sdk.firstDelta': 10_000,
    'xterm.write': 50,
  },
});

/** anon はエクスポートして共有する前提なので小さく、dev は手元で溜める前提で大きく。 */
const DIR_CAP_BYTES: Record<Exclude<MetricsTier, 'off'>, number> = {
  anon: 20 * 1024 * 1024,
  dev: 200 * 1024 * 1024,
};

export interface MetricsInfo {
  tier: MetricsTier;
  source: MetricsConfig['source'];
  locked: boolean;
  run: string;
  dir: string;
  sink: SinkStats | null;
}

interface Active {
  cfg: MetricsConfig;
  sink: Sink;
  sampler: SamplerHandle;
}

/** サーバープロセスごとの乱数 id。クライアントの記録と結合する鍵で、個人を識別しない。 */
export const RUN_ID = randomBytes(4).toString('hex');

let cfg: MetricsConfig = { tier: 'off', source: 'default', locked: false, dir: metricsDir('off') };
let active: Active | null = null;
let statsProvider: () => Partial<AppStats> = () => ({});
let exitHookInstalled = false;
let log: (message: string) => void = () => {};

let cachedVersion: string | null | undefined;
/** package.json の version (dev: server/metrics → ../../、配布: dist/server/metrics → ../../../)。 */
export function packageVersion(): string | null {
  if (cachedVersion === undefined) cachedVersion = readPackageVersion();
  return cachedVersion;
}

function readPackageVersion(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.resolve(here, '../../package.json'), path.resolve(here, '../../../package.json')]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { name?: unknown; version?: unknown };
      if (parsed.name === 'prontella' && typeof parsed.version === 'string') return parsed.version;
    } catch {
      // 次の候補へ
    }
  }
  return null;
}

function metaRecord(tier: MetricsTier): MetricRecord {
  const version = packageVersion();
  return {
    k: 'meta',
    t: Date.now(),
    tier,
    ...(version ? { version } : {}),
    node: process.version,
    platform: platformLabel(process.platform),
    arch: archLabel(process.arch),
    pid: process.pid,
  };
}

/**
 * レコードを現在の tier で整形して書く。anon は閉じた allowlist 検査に通らなければ捨てる
 * (`metrics.self.scrubDropped` に計上)。戻り値は書けたかどうか。
 */
export function writeRecord(record: MetricRecord, src: 'server' | 'client'): boolean {
  const current = active;
  if (!current) return false;
  const stamped: MetricRecord = { ...record, run: RUN_ID, src };
  if (current.cfg.tier === 'anon' && checkAnon(stamped) !== null) {
    metrics.count('metrics.self.scrubDropped', 1, { src });
    return false;
  }
  current.sink.write(JSON.stringify(stamped));
  return true;
}

function stopActive(): void {
  const current = active;
  if (!current) return;
  active = null;
  metrics.enabled = false;
  metrics.includeAttrs = false;
  metrics.onEvent = () => {};
  current.sampler.stop();
  current.sink.close();
}

function apply(next: MetricsConfig): void {
  stopActive();
  cfg = next;
  if (next.tier === 'off') return;
  const tier = next.tier;
  const sink = createJsonlSink({ dir: next.dir, maxDirBytes: DIR_CAP_BYTES[tier] });
  metrics.includeAttrs = tier === 'dev';
  metrics.onEvent = (record) => void writeRecord(record, 'server');
  metrics.enabled = true;
  const sampler = startSampler({
    registry: metrics,
    tier,
    emit: (record) => void writeRecord(record, 'server'),
    stats: () => {
      const s = sink.stats();
      return {
        ...statsProvider(),
        sinkWritten: s.written,
        sinkDropped: s.dropped,
        sinkFlushErrors: s.flushErrors,
      };
    },
  });
  active = { cfg: next, sink, sampler };
  writeRecord(metaRecord(tier), 'server');
  log(`metrics: tier=${tier} (${next.source}) → ${next.dir}`);
}

export function initMetrics(opts: {
  stats?: () => Partial<AppStats>;
  log?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
} = {}): MetricsInfo {
  if (opts.stats) statsProvider = opts.stats;
  if (opts.log) log = opts.log;
  const next = loadMetricsConfig(opts.env);
  if (next.invalidEnv !== undefined) {
    log(`PRONTELLA_METRICS=${JSON.stringify(next.invalidEnv)} は不正な値です (off | anon | dev)。無視します。`);
  }
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // 'exit' は同期処理しかできないので sink.close() の同期 append で残りを書く。
    // SIGINT 等の既定動作は変えない (ハンドラーを足すと既定の終了が止まるため)。
    process.on('exit', () => stopActive());
  }
  apply(next);
  return metricsInfo();
}

export function metricsInfo(): MetricsInfo {
  return {
    tier: cfg.tier,
    source: cfg.source,
    locked: cfg.locked,
    run: RUN_ID,
    dir: cfg.dir,
    sink: active ? active.sink.stats() : null,
  };
}

/**
 * API からの tier 変更。環境変数で固定されているときは変更しない (呼び出し側が 409 にする)。
 * config.json に永続化してから差し替える。
 */
export function setMetricsTier(tier: 'off' | 'anon'): MetricsInfo {
  if (cfg.locked) throw new Error(`metrics tier is locked by environment (${cfg.tier})`);
  setConfiguredTier(tier);
  apply(loadMetricsConfig());
  return metricsInfo();
}

/** テスト・終了用。 */
export function stopMetrics(): void {
  stopActive();
  cfg = { tier: 'off', source: 'default', locked: false, dir: metricsDir('off') };
}

/** テスト用: 設定を経由せず直接 tier とディレクトリーを指定して起動する。 */
export function startMetricsForTest(tier: Exclude<MetricsTier, 'off'>, dir: string, stats?: () => Partial<AppStats>): void {
  if (stats) statsProvider = stats;
  apply({ tier, source: 'env', locked: true, dir });
}
