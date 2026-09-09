import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, loadConfig, saveConfig } from '../config.js';

/**
 * メトリクス収集の層 (tier)。
 *
 * - off:  何も収集しない (既定)。レジストリは無効化され、タイマーもファイルも作らない
 * - anon: 匿名メトリクス。利用者が opt-in する。パス・リポジトリー名・セッション id・
 *         プロンプト等を一切含まない (server/metrics/scrub.ts の閉じた allowlist で整形)
 * - dev:  Prontella 開発者向け。cwd・ルート・git 引数などを含む詳細記録。
 *         API からは設定できず、環境変数か config.json の手編集でのみ有効化する
 */
export type MetricsTier = 'off' | 'anon' | 'dev';
export type TierSource = 'env' | 'config' | 'default';

export const TIERS: readonly MetricsTier[] = ['off', 'anon', 'dev'];

export const METRICS_ENV = 'PRONTELLA_METRICS';

export interface MetricsConfig {
  tier: MetricsTier;
  source: TierSource;
  /** 環境変数で固定されているか (API からの変更を 409 で拒否する)。 */
  locked: boolean;
  /** この tier の JSONL 出力ディレクトリー (`~/.prontella/metrics/<tier>`)。 */
  dir: string;
  /** 環境変数に不正な値があったときの生の値 (起動ログで警告するため)。 */
  invalidEnv?: string;
}

export function isTier(value: unknown): value is MetricsTier {
  return typeof value === 'string' && (TIERS as readonly string[]).includes(value);
}

/** API 経由で設定できる tier (dev は含めない)。 */
export function isUserSettableTier(value: unknown): value is 'off' | 'anon' {
  return value === 'off' || value === 'anon';
}

/**
 * tier の決定 (純関数)。優先順位: 環境変数 > config.json の `metrics.tier` > off。
 * 環境変数が設定されているが不正な値のときは無視して次へ落ちる (`invalidEnv` で報告)。
 * config 側の不正値も同様に無視する (壊れた設定で収集が勝手に始まらないよう安全側)。
 */
export function resolveTier(
  envValue: unknown,
  configMetrics: unknown,
): { tier: MetricsTier; source: TierSource; invalidEnv?: string } {
  let invalidEnv: string | undefined;
  if (typeof envValue === 'string' && envValue.trim() !== '') {
    const normalized = envValue.trim().toLowerCase();
    if (isTier(normalized)) return { tier: normalized, source: 'env' };
    invalidEnv = envValue;
  }
  if (configMetrics !== null && typeof configMetrics === 'object' && !Array.isArray(configMetrics)) {
    const tier = (configMetrics as Record<string, unknown>).tier;
    if (isTier(tier)) return { tier, source: 'config', invalidEnv };
  }
  return { tier: 'off', source: 'default', invalidEnv };
}

export function metricsDir(tier: MetricsTier): string {
  return path.join(CONFIG_DIR, 'metrics', tier);
}

/**
 * config.json の `metrics` キーを副作用なしで読む。`loadConfig()` は JSON 破損時に
 * ファイルを退避する (server/config.ts) が、メトリクス初期化は起動時・テストの import 時にも
 * 走るため、読み取り専用の経路を別に持つ。読めなければ undefined (= 収集しない側)。
 */
function peekConfigMetrics(): unknown {
  try {
    const raw = fs.readFileSync(path.join(CONFIG_DIR, 'config.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return (parsed as Record<string, unknown>).metrics;
    }
  } catch {
    // ENOENT / 破損 / 権限 — いずれも「設定なし」として扱う
  }
  return undefined;
}

/**
 * 起動時・再設定時の設定読み込み。config.json が読めない (破損退避中など) ときは
 * 収集を始めない側に倒す — メトリクスのために本体の起動を止めない。
 */
export function loadMetricsConfig(env: NodeJS.ProcessEnv = process.env): MetricsConfig {
  const configMetrics = peekConfigMetrics();
  const resolved = resolveTier(env[METRICS_ENV], configMetrics);
  return {
    tier: resolved.tier,
    source: resolved.source,
    locked: resolved.source === 'env',
    dir: metricsDir(resolved.tier),
    ...(resolved.invalidEnv !== undefined ? { invalidEnv: resolved.invalidEnv } : {}),
  };
}

/**
 * config.json の `metrics.tier` を書き換える。loadConfig → saveConfig の間に await を
 * 置かない (server/config.ts の read-modify-write 規律)。`metrics` 配下の他キーは保持する。
 */
export function setConfiguredTier(tier: 'off' | 'anon'): void {
  const config = loadConfig();
  const existing = config.metrics;
  const metrics =
    existing !== null && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>), tier }
      : { tier };
  saveConfig({ ...config, metrics });
}
