import type { MetricRecord } from './registry.js';

/**
 * クライアント → サーバーのバッチ送信。
 *
 * - 通常: interval ごとに `fetch(url, { keepalive: true })` で `{ records }` を POST。
 *   keepalive fetch は in-flight 合計 64KB の制限があるので、1 回の本文を 60KB 以下に刻む
 * - ページ離脱 (`pagehide`) / 非表示化: `navigator.sendBeacon` で 1 発。60KB を超えるぶんは
 *   **最新の snapshot と新しいイベント**を優先して残し、古いものを捨てる (`onTruncated` に通知)
 * - 送信失敗は再送しない (再送キューが育つと計測が本体の帯域を食う)。捨てた数だけ数える
 *
 * サーバー側 (server/metrics/ingest.ts) が検証と tier 別スクラブの権威。ここは形を整えるだけ。
 */

export interface Transport {
  push(record: MetricRecord): void;
  flush(reason: 'timer' | 'hide' | 'manual'): void;
  stop(): void;
  stats(): { sent: number; dropped: number; truncated: number };
}

export interface TransportOptions {
  url: string;
  intervalMs: number;
  maxQueue?: number;
  /** 1 リクエストの本文上限 (バイト)。 */
  bodyLimit?: number;
  fetchImpl?: (url: string, init: RequestInit) => Promise<unknown>;
  beacon?: (url: string, body: Blob) => boolean;
  /** テスト用: window/document のイベント購読を止める。 */
  listen?: boolean;
}

const DEFAULT_MAX_QUEUE = 500;
const DEFAULT_BODY_LIMIT = 60_000;

/** 本文上限に収まるまで、古い方から落とす (最新の snapshot は必ず残す)。 */
export function fitToLimit(records: MetricRecord[], limit: number): { kept: MetricRecord[]; dropped: number } {
  let lastSnapshot = -1;
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].k === 'snapshot') {
      lastSnapshot = i;
      break;
    }
  }
  const ordered = lastSnapshot >= 0 ? [records[lastSnapshot], ...records.filter((_, i) => i !== lastSnapshot).reverse()] : [...records].reverse();
  const kept: MetricRecord[] = [];
  let size = 16; // {"records":[]} の分
  for (const record of ordered) {
    const len = JSON.stringify(record).length + 1;
    if (size + len > limit) {
      if (kept.length === 0) continue; // 1 件も入らない巨大レコードは飛ばす
      break;
    }
    size += len;
    kept.push(record);
  }
  // 時系列順に戻す
  kept.sort((a, b) => a.t - b.t);
  return { kept, dropped: records.length - kept.length };
}

export function createTransport(opts: TransportOptions): Transport {
  const maxQueue = opts.maxQueue ?? DEFAULT_MAX_QUEUE;
  const bodyLimit = opts.bodyLimit ?? DEFAULT_BODY_LIMIT;
  const fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const beacon =
    opts.beacon ??
    ((url, body) => (typeof navigator !== 'undefined' && 'sendBeacon' in navigator ? navigator.sendBeacon(url, body) : false));
  let queue: MetricRecord[] = [];
  let stopped = false;
  let sending = false;
  const stats = { sent: 0, dropped: 0, truncated: 0 };

  function takeAll(): MetricRecord[] {
    const out = queue;
    queue = [];
    return out;
  }

  /** キューを本文上限ごとに区切って順に POST する。 */
  async function sendAll(): Promise<void> {
    if (sending) return;
    sending = true;
    try {
      while (queue.length > 0 && !stopped) {
        const batch: MetricRecord[] = [];
        let size = 16;
        while (queue.length > 0) {
          const len = JSON.stringify(queue[0]).length + 1;
          if (batch.length > 0 && size + len > bodyLimit) break;
          size += len;
          batch.push(queue.shift() as MetricRecord);
        }
        try {
          await fetchImpl(opts.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ records: batch }),
            keepalive: true,
          });
          stats.sent += batch.length;
        } catch {
          stats.dropped += batch.length;
        }
      }
    } finally {
      sending = false;
    }
  }

  function sendBeaconNow(): void {
    const records = takeAll();
    if (records.length === 0) return;
    const { kept, dropped } = fitToLimit(records, bodyLimit);
    if (dropped > 0) stats.truncated += dropped;
    if (kept.length === 0) return;
    const ok = beacon(opts.url, new Blob([JSON.stringify({ records: kept })], { type: 'application/json' }));
    if (ok) stats.sent += kept.length;
    else stats.dropped += kept.length;
  }

  const timer = setInterval(() => void sendAll(), opts.intervalMs);

  const onPageHide = () => sendBeaconNow();
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') sendBeaconNow();
  };
  const listen = opts.listen ?? typeof window !== 'undefined';
  if (listen) {
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);
  }

  return {
    push(record) {
      if (stopped) return;
      if (queue.length >= maxQueue) {
        queue.shift();
        stats.dropped += 1;
      }
      queue.push(record);
    },
    flush(reason) {
      if (reason === 'hide') sendBeaconNow();
      else void sendAll();
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      if (listen) {
        window.removeEventListener('pagehide', onPageHide);
        document.removeEventListener('visibilitychange', onVisibility);
      }
    },
    stats: () => ({ ...stats }),
  };
}
