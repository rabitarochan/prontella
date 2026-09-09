import { performance } from 'node:perf_hooks';

/**
 * メトリクスレジストリ: カウンター / ゲージ / ヒストグラム / span。
 *
 * 負荷制約 (計測自身がホットパスの CPU を食わない) から、設計は次のとおり:
 * - ホットパスは `counter()` / `histogram()` で **ハンドルを先に取り**、`add()` / `observe()` で
 *   配列への整数加算だけを行う (Map 引き・オブジェクト生成・文字列連結なし)
 * - `enabled` が false のときは全メソッドが分岐 1 つで抜ける。レジストリ自体はモジュール読み込み時に
 *   生成してよい (タイマーもファイルも持たない)
 * - I/O は持たない。`snapshot()` で要約を取り出す側 (sampler) と、稀な `event()` を書く側 (onEvent)
 *   に分離する
 *
 * ヒストグラムは 0.05ms から 2 倍刻みの 24 バケット (最大 ≈7 分)。パーセンタイルはバケット上限で
 * 推定する (min/max/sum/count は正確)。
 */

export const HIST_BUCKET_COUNT = 24;
/** バケット i は `value <= HIST_BUCKETS[i]` を数える。最終バケットはそれ以上すべて。 */
export const HIST_BUCKETS: readonly number[] = Array.from({ length: HIST_BUCKET_COUNT }, (_, i) => 0.05 * 2 ** i);

export interface Labels {
  readonly [key: string]: string;
}
export interface Attrs {
  readonly [key: string]: string | number | boolean | null | undefined;
}

export interface CounterHandle {
  add(delta?: number): void;
}
export interface HistogramHandle {
  observe(valueMs: number): void;
}
export type EndSpan = (extra?: Attrs) => number;

export interface HistSummary {
  c: number;
  sum: number;
  min: number;
  max: number;
  p50: number;
  p90: number;
  p99: number;
}
export interface SeriesEntry {
  n: string;
  l?: Labels;
  v: number;
}
export interface HistEntry {
  n: string;
  l?: Labels;
  h: HistSummary;
}
export interface SpanTrace {
  n: string;
  t: number;
  ph: 's' | 'e';
  ms?: number;
}
export interface RegistrySnapshot {
  counters: SeriesEntry[];
  gauges: SeriesEntry[];
  hist: HistEntry[];
}
export interface MetricRecord {
  k: string;
  t: number;
  [key: string]: unknown;
}

export interface RegistryOptions {
  /** span 名ごとの「遅い」しきい値 (ms)。無ければ defaultSlowMs。 */
  slowMs?: Record<string, number>;
  defaultSlowMs?: number;
  spanRingSize?: number;
}

interface Hist {
  n: string;
  l?: Labels;
  buckets: Uint32Array;
  c: number;
  sum: number;
  min: number;
  max: number;
}

function seriesKey(name: string, labels?: Labels): string {
  if (!labels) return name;
  const keys = Object.keys(labels).sort();
  let key = name;
  for (const k of keys) key += `|${k}=${labels[k]}`;
  return key;
}

function bucketIndex(valueMs: number): number {
  if (!(valueMs > HIST_BUCKETS[0])) return 0;
  const i = Math.ceil(Math.log2(valueMs / HIST_BUCKETS[0]));
  return i >= HIST_BUCKET_COUNT ? HIST_BUCKET_COUNT - 1 : i;
}

function percentile(h: Hist, p: number): number {
  if (h.c === 0) return 0;
  const rank = Math.ceil(p * h.c);
  let cum = 0;
  for (let i = 0; i < HIST_BUCKET_COUNT; i++) {
    cum += h.buckets[i];
    if (cum >= rank) {
      const upper = i === HIST_BUCKET_COUNT - 1 ? h.max : HIST_BUCKETS[i];
      return Math.min(Math.max(upper, h.min), h.max);
    }
  }
  return h.max;
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

export class Registry {
  enabled = false;
  /**
   * 自由形式の付帯情報 (`attrs` / `devFields`: cwd・git 引数など) をイベントに載せるか。
   * dev 層でのみ true。anon 層で載せると scrub がレコードごと落とすため、そもそも付けない。
   */
  includeAttrs = false;
  /** 稀なイベント (slow / hang / session ...) の書き出し先。合成ルートが差し込む。 */
  onEvent: (record: MetricRecord) => void = () => {};

  private readonly slowMs: Record<string, number>;
  private readonly defaultSlowMs: number;

  private readonly counterIndex = new Map<string, number>();
  private readonly counterValues: number[] = [];
  private readonly counterMeta: { n: string; l?: Labels }[] = [];

  private readonly gaugeIndex = new Map<string, number>();
  private readonly gaugeValues: number[] = [];
  private readonly gaugeMeta: { n: string; l?: Labels }[] = [];

  private readonly histIndex = new Map<string, number>();
  private readonly hists: Hist[] = [];

  private readonly ring: (SpanTrace | undefined)[];
  private ringPos = 0;

  constructor(opts: RegistryOptions = {}) {
    this.slowMs = opts.slowMs ?? {};
    this.defaultSlowMs = opts.defaultSlowMs ?? 250;
    this.ring = new Array<SpanTrace | undefined>(opts.spanRingSize ?? 32);
  }

  // ---- counters ---------------------------------------------------------

  private counterSlot(name: string, labels?: Labels): number {
    const key = seriesKey(name, labels);
    let slot = this.counterIndex.get(key);
    if (slot === undefined) {
      slot = this.counterValues.length;
      this.counterIndex.set(key, slot);
      this.counterValues.push(0);
      this.counterMeta.push(labels ? { n: name, l: { ...labels } } : { n: name });
    }
    return slot;
  }

  /** ホットパス用ハンドル。一度取って閉じ込めておく。 */
  counter(name: string, labels?: Labels): CounterHandle {
    const slot = this.counterSlot(name, labels);
    const values = this.counterValues;
    return {
      add: (delta = 1) => {
        if (this.enabled) values[slot] += delta;
      },
    };
  }

  count(name: string, delta = 1, labels?: Labels): void {
    if (!this.enabled) return;
    this.counterValues[this.counterSlot(name, labels)] += delta;
  }

  // ---- gauges -------------------------------------------------------------

  gauge(name: string, value: number, labels?: Labels): void {
    if (!this.enabled) return;
    const key = seriesKey(name, labels);
    let slot = this.gaugeIndex.get(key);
    if (slot === undefined) {
      slot = this.gaugeValues.length;
      this.gaugeIndex.set(key, slot);
      this.gaugeValues.push(value);
      this.gaugeMeta.push(labels ? { n: name, l: { ...labels } } : { n: name });
      return;
    }
    this.gaugeValues[slot] = value;
  }

  // ---- histograms / spans --------------------------------------------------

  private histSlot(name: string, labels?: Labels): Hist {
    const key = seriesKey(name, labels);
    let slot = this.histIndex.get(key);
    if (slot === undefined) {
      slot = this.hists.length;
      this.histIndex.set(key, slot);
      this.hists.push({
        n: name,
        ...(labels ? { l: { ...labels } } : {}),
        buckets: new Uint32Array(HIST_BUCKET_COUNT),
        c: 0,
        sum: 0,
        min: Infinity,
        max: -Infinity,
      });
    }
    return this.hists[slot];
  }

  private static observeInto(h: Hist, valueMs: number): void {
    h.buckets[bucketIndex(valueMs)] += 1;
    h.c += 1;
    h.sum += valueMs;
    if (valueMs < h.min) h.min = valueMs;
    if (valueMs > h.max) h.max = valueMs;
  }

  histogram(name: string, labels?: Labels): HistogramHandle {
    const h = this.histSlot(name, labels);
    return {
      observe: (valueMs) => {
        if (this.enabled) Registry.observeInto(h, valueMs);
      },
    };
  }

  observe(name: string, valueMs: number, labels?: Labels): void {
    if (!this.enabled) return;
    Registry.observeInto(this.histSlot(name, labels), valueMs);
  }

  private pushTrace(trace: SpanTrace): void {
    this.ring[this.ringPos] = trace;
    this.ringPos = (this.ringPos + 1) % this.ring.length;
  }

  /** 直近の span 遷移 (古い順)。ハング検知の帰属に使う。 */
  recentSpans(): SpanTrace[] {
    const out: SpanTrace[] = [];
    for (let i = 0; i < this.ring.length; i++) {
      const trace = this.ring[(this.ringPos + i) % this.ring.length];
      if (trace) out.push(trace);
    }
    return out;
  }

  /**
   * 計測済みの所要時間を span として記録する (`startSpan` の終了処理と同じ)。
   * ヒストグラムには `labels` の系列で入れ、遅ければ `slow` イベントに `attrs` を添える。
   * `labels` は語彙内の文字列のみ、`attrs` は dev 層向けの自由な付帯情報 (anon では scrub が落とす)。
   */
  recordSpan(name: string, ms: number, labels?: Labels, attrs?: Attrs): void {
    if (!this.enabled) return;
    Registry.observeInto(this.histSlot(name, labels), ms);
    this.pushTrace({ n: name, t: Date.now(), ph: 'e', ms: round3(ms) });
    const threshold = this.slowMs[name] ?? this.defaultSlowMs;
    if (ms >= threshold) {
      this.onEvent({
        k: 'slow',
        t: Date.now(),
        n: name,
        ms: round3(ms),
        ...labels,
        ...(this.includeAttrs ? attrs : undefined),
      });
    }
  }

  startSpan(name: string, labels?: Labels, attrs?: Attrs): EndSpan {
    if (!this.enabled) return () => 0;
    const t0 = performance.now();
    this.pushTrace({ n: name, t: Date.now(), ph: 's' });
    let ended = false;
    return (extra?: Attrs) => {
      const ms = performance.now() - t0;
      if (ended) return ms;
      ended = true;
      this.recordSpan(name, ms, labels, extra ? { ...attrs, ...extra } : attrs);
      return ms;
    };
  }

  /** 同期でも Promise でも計測する。例外・reject は握りつぶさず、計測だけして再送出する。 */
  withSpan<T>(name: string, fn: () => T, labels?: Labels, attrs?: Attrs): T {
    if (!this.enabled) return fn();
    const end = this.startSpan(name, labels, attrs);
    let result: T;
    try {
      result = fn();
    } catch (err) {
      end({ err: true });
      throw err;
    }
    if (result instanceof Promise) {
      return result.then(
        (value) => {
          end();
          return value;
        },
        (err: unknown) => {
          end({ err: true });
          throw err;
        },
      ) as T;
    }
    end();
    return result;
  }

  // ---- events / snapshot ----------------------------------------------------

  /**
   * 稀なイベントを書く。`fields` は語彙内の文字列と数値だけ (anon でも通る)、
   * `devFields` は dev 層でのみ付く自由形式 (cwd・引数・エラーメッセージ等)。
   */
  event(kind: string, fields: Record<string, unknown>, devFields?: Record<string, unknown>): void {
    if (!this.enabled) return;
    this.onEvent({ k: kind, t: Date.now(), ...fields, ...(this.includeAttrs ? devFields : undefined) });
  }

  /** カウンターは累積のまま返し、ヒストグラムは返した後にリセットする (区間ごとの分布)。 */
  snapshot(): RegistrySnapshot {
    const counters: SeriesEntry[] = [];
    for (let i = 0; i < this.counterValues.length; i++) {
      const meta = this.counterMeta[i];
      counters.push(meta.l ? { n: meta.n, l: meta.l, v: this.counterValues[i] } : { n: meta.n, v: this.counterValues[i] });
    }
    const gauges: SeriesEntry[] = [];
    for (let i = 0; i < this.gaugeValues.length; i++) {
      const meta = this.gaugeMeta[i];
      gauges.push(meta.l ? { n: meta.n, l: meta.l, v: this.gaugeValues[i] } : { n: meta.n, v: this.gaugeValues[i] });
    }
    const hist: HistEntry[] = [];
    for (const h of this.hists) {
      if (h.c === 0) continue;
      const summary: HistSummary = {
        c: h.c,
        sum: round3(h.sum),
        min: round3(h.min),
        max: round3(h.max),
        p50: round3(percentile(h, 0.5)),
        p90: round3(percentile(h, 0.9)),
        p99: round3(percentile(h, 0.99)),
      };
      hist.push(h.l ? { n: h.n, l: h.l, h: summary } : { n: h.n, h: summary });
      h.buckets.fill(0);
      h.c = 0;
      h.sum = 0;
      h.min = Infinity;
      h.max = -Infinity;
    }
    return { counters, gauges, hist };
  }

  /** テスト・再設定用。系列を全て捨てる (ハンドルは無効になるので再設定では使わない)。 */
  reset(): void {
    this.counterIndex.clear();
    this.counterValues.length = 0;
    this.counterMeta.length = 0;
    this.gaugeIndex.clear();
    this.gaugeValues.length = 0;
    this.gaugeMeta.length = 0;
    this.histIndex.clear();
    this.hists.length = 0;
    this.ring.fill(undefined);
    this.ringPos = 0;
  }
}
