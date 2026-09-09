import { create } from 'zustand';
import { liveSocketCount, setLiveSocketObserver, type LinkPhase } from '../lib/liveSocket.js';
import { currentTileCount, metrics } from './core.js';
import { installHooks } from './hooks.js';
import type { CounterHandle } from './registry.js';
import { startSamplers } from './samplers.js';
import { tabId } from './tab.js';
import { createTransport, type Transport } from './transport.js';

export { metrics, reportTileCount } from './core.js';

/**
 * クライアント側メトリクスの合成ルート。
 *
 * サーバーが tier の権威: 起動時に `GET /api/metrics/config` を 1 回引き、off なら何も入れない
 * (オブザーバーもタイマーも作らない)。有効なら registry を enable し、サンプラー・フック・
 * バッチ送信を立てる。計測点は `metrics.counter(...)` のハンドルを閉じ込めてよい (off の間は
 * 分岐 1 つで抜ける)。
 */

export type MetricsTier = 'off' | 'anon' | 'dev';

export interface MetricsConfigState {
  tier: MetricsTier;
  locked: boolean;
  run: string | null;
  loaded: boolean;
}

export const useMetricsConfig = create<MetricsConfigState>(() => ({
  tier: 'off',
  locked: false,
  run: null,
  loaded: false,
}));

const INTERVALS: Record<Exclude<MetricsTier, 'off'>, { sample: number; send: number }> = {
  dev: { sample: 5_000, send: 10_000 },
  anon: { sample: 30_000, send: 60_000 },
};

/**
 * liveSocket の相転移とフレームをレジストリへ写す。path はクエリを剥いだ `/ws/term` 等で、
 * セッション id は渡ってこない。フレームごとの処理はハンドル経由の整数加算だけ。
 */
function wireLiveSocketObserver(): void {
  const handles = new Map<string, CounterHandle>();
  const handle = (name: string, path: string): CounterHandle => {
    const key = `${name}|${path}`;
    let h = handles.get(key);
    if (!h) {
      h = metrics.counter(name, { path });
      handles.set(key, h);
    }
    return h;
  };
  setLiveSocketObserver({
    onPhase(path: string, phase: LinkPhase, attempt: number) {
      metrics.count('ws.phase', 1, { path, phase });
      if (phase === 'reconnecting') metrics.event('ws', { path, phase, attempt });
    },
    onFrame(path: string, dir: 'in' | 'out', bytes: number) {
      handle(dir === 'in' ? 'ws.frames.in' : 'ws.frames.out', path).add();
      handle(dir === 'in' ? 'ws.bytes.in' : 'ws.bytes.out', path).add(bytes);
    },
  });
}

interface Active {
  tier: Exclude<MetricsTier, 'off'>;
  transport: Transport;
  stopSamplers: () => void;
  stopHooks: () => void;
}
let active: Active | null = null;

function stop(): void {
  const current = active;
  if (!current) return;
  active = null;
  metrics.enabled = false;
  metrics.includeAttrs = false;
  metrics.onEvent = () => {};
  setLiveSocketObserver(null);
  current.stopSamplers();
  current.stopHooks();
  current.transport.flush('hide');
  current.transport.stop();
}

function start(tier: Exclude<MetricsTier, 'off'>): void {
  stop();
  const tab = tabId();
  const transport = createTransport({ url: '/api/metrics/ingest', intervalMs: INTERVALS[tier].send });
  metrics.includeAttrs = tier === 'dev';
  metrics.onEvent = (record) => transport.push({ ...record, tab });
  metrics.enabled = true;
  wireLiveSocketObserver();
  const stopHooks = installHooks(metrics, { tier });
  const stopSamplers = startSamplers({
    registry: metrics,
    intervalMs: INTERVALS[tier].sample,
    emit: (record) => transport.push({ ...record, tab }),
    liveSockets: liveSocketCount,
    tiles: currentTileCount,
  });
  active = { tier, transport, stopSamplers, stopHooks };
}

function applyConfig(cfg: { tier?: unknown; locked?: unknown; run?: unknown }): void {
  const tier: MetricsTier = cfg.tier === 'anon' || cfg.tier === 'dev' ? cfg.tier : 'off';
  useMetricsConfig.setState({
    tier,
    locked: cfg.locked === true,
    run: typeof cfg.run === 'string' ? cfg.run : null,
    loaded: true,
  });
  if (tier === 'off') stop();
  else if (!active || active.tier !== tier) start(tier);
}

/** 起動時に 1 回。失敗しても本体には影響させない (計測なしで続行)。 */
export async function bootMetrics(): Promise<void> {
  try {
    const res = await fetch('/api/metrics/config');
    if (!res.ok) return;
    applyConfig((await res.json()) as Record<string, unknown>);
  } catch {
    useMetricsConfig.setState({ loaded: true });
  }
}

/** コマンドパレットから: 匿名メトリクスの on/off。dev は API から設定できない。 */
export async function setMetricsTier(tier: 'off' | 'anon'): Promise<void> {
  const res = await fetch('/api/metrics/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tier }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  applyConfig((await res.json()) as Record<string, unknown>);
}
