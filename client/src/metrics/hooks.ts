import type { Registry } from './registry.js';

/**
 * ハング/ストール検知のオブザーバー群。
 *
 * - longtask: 50ms 超のメインスレッド占有。500ms 以上は `hang` イベント (帰属 + 直近 span)
 * - stall: 250ms タイマーのドリフト。可視状態で 200ms 超なら `stall` (バックグラウンドの
 *   タイマー間引きと区別するため、非表示中は数えない)
 * - event timing: 104ms 超の入力応答 (INP 相当)。ターゲットを粗い種別に潰して記録する
 * - rafgap (dev のみ): 1 秒ごとの rAF プローブが 250ms 以上遅れた = レンダラー/コンポジターの停止
 *
 * どれも `enabled` でないレジストリには何も記録しない。
 */

const HANG_MS = 500;
const STALL_TICK_MS = 250;
const STALL_MS = 200;
const RAF_GAP_MS = 250;
const RAF_PROBE_MS = 1_000;
const INPUT_THRESHOLD_MS = 104;

type Attribution = 'window' | 'iframe' | 'unknown' | 'xterm' | 'monaco-editor' | 'tree' | 'other';

function classifyTarget(target: unknown): Attribution {
  if (!(target instanceof Element)) return 'other';
  if (target.closest('.xterm')) return 'xterm';
  if (target.closest('.monaco-editor')) return 'monaco-editor';
  if (target.closest('[role="tree"], [role="treeitem"]')) return 'tree';
  return 'other';
}

function containerAttribution(entry: PerformanceEntry): Attribution {
  const attribution = (entry as { attribution?: { containerType?: string }[] }).attribution;
  const type = attribution?.[0]?.containerType;
  if (type === 'window') return 'window';
  if (type === 'iframe') return 'iframe';
  return 'unknown';
}

function activity(): 'active' | 'inactive' {
  return document.visibilityState === 'visible' && document.hasFocus() ? 'active' : 'inactive';
}

export function installHooks(registry: Registry, opts: { tier: 'anon' | 'dev' }): () => void {
  const disposers: (() => void)[] = [];

  if (typeof PerformanceObserver !== 'undefined') {
    try {
      const longtask = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          registry.observe('longtask', entry.duration);
          if (entry.duration >= HANG_MS) {
            registry.event('hang', {
              ms: Math.round(entry.duration),
              attr: containerAttribution(entry),
              act: activity(),
              recent: registry.recentSpans(),
            });
          }
        }
      });
      longtask.observe({ type: 'longtask', buffered: true });
      disposers.push(() => longtask.disconnect());
    } catch {
      // longtask 未対応ブラウザー
    }
    try {
      const input = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const target = (entry as { target?: unknown }).target;
          registry.observe('input', entry.duration, { attr: classifyTarget(target) });
        }
      });
      input.observe({ type: 'event', durationThreshold: INPUT_THRESHOLD_MS } as PerformanceObserverInit);
      disposers.push(() => input.disconnect());
    } catch {
      // event timing 未対応
    }
  }

  let expected = performance.now() + STALL_TICK_MS;
  const stallTimer = setInterval(() => {
    const now = performance.now();
    const drift = now - expected;
    expected = now + STALL_TICK_MS;
    if (drift > STALL_MS && document.visibilityState === 'visible') {
      registry.event('stall', { ms: Math.round(drift), act: activity(), recent: registry.recentSpans() });
    }
  }, STALL_TICK_MS);
  disposers.push(() => clearInterval(stallTimer));

  if (opts.tier === 'dev') {
    // 常時 rAF ループは毎フレーム JS タスクを立てて計測自身が負荷になる (2026-09-09 の bench で
    // dev 層のページ TaskDuration が +17〜31%)。1 秒ごとに rAF を 1 回だけ要求し、
    // 「要求からコールバックまでの遅延」でレンダラーの停止を測る。
    let raf = 0;
    const probe = setInterval(() => {
      if (document.visibilityState !== 'visible' || raf) return;
      const requested = performance.now();
      raf = requestAnimationFrame(() => {
        raf = 0;
        const latency = performance.now() - requested;
        if (latency > RAF_GAP_MS) registry.event('rafgap', { ms: Math.round(latency), act: activity() });
      });
    }, RAF_PROBE_MS);
    disposers.push(() => {
      clearInterval(probe);
      if (raf) cancelAnimationFrame(raf);
    });
  }

  return () => {
    for (const dispose of disposers) dispose();
  };
}
