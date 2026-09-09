/**
 * クライアント側メトリクスレジストリ。server/metrics/registry.ts と同じ API・同じバケット境界。
 *
 * 実装を意図的に複製している: server と client は tsconfig の rootDir / include が分かれており、
 * 共有ディレクトリーを作ると両方の構成を崩す。バケット境界 (`HIST_BUCKETS`) が一致することは
 * registry.test.ts が固定する。
 *
 * ホットパス (xterm の write 分岐・liveSocket の onmessage) は `counter()` のハンドルを閉じ込め、
 * `add()` の整数加算だけを行う。`enabled` が false の間は全メソッドが分岐 1 つで抜ける。
 */

export const HIST_BUCKET_COUNT = 24;
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
export interface MetricRecord {
  k: string;
  t: number;
  [key: string]: unknown;
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
  includeAttrs = false;
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

  constructor(opts: { slowMs?: Record<string, number>; defaultSlowMs?: number; spanRingSize?: number } = {}) {
    this.slowMs = opts.slowMs ?? {};
    this.defaultSlowMs = opts.defaultSlowMs ?? 250;
    this.ring = new Array<SpanTrace | undefined>(opts.spanRingSize ?? 32);
  }

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

  recentSpans(): SpanTrace[] {
    const out: SpanTrace[] = [];
    for (let i = 0; i < this.ring.length; i++) {
      const trace = this.ring[(this.ringPos + i) % this.ring.length];
      if (trace) out.push(trace);
    }
    return out;
  }

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

  event(kind: string, fields: Record<string, unknown>, devFields?: Record<string, unknown>): void {
    if (!this.enabled) return;
    this.onEvent({ k: kind, t: Date.now(), ...fields, ...(this.includeAttrs ? devFields : undefined) });
  }

  snapshot(): { counters: SeriesEntry[]; gauges: SeriesEntry[]; hist: HistEntry[] } {
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
}
