import * as monaco from 'monaco-editor';
import type { MetricRecord, Registry } from './registry.js';

/**
 * 定期サンプラー (可視状態のときだけ動く)。ゲージを更新してから `snapshot` レコードを出す。
 *
 * リーク検知の比に使う実体数:
 * - `.xterm` の数 (xterm インスタンス)、`.xterm-screen canvas` の数 (WebGL 端末 1 枚あたり 2 が健全)、
 *   `webglcontextlost` の累計 (JS ヒープには現れない WebGL コンテキストの枯渇の信号)
 * - Monaco のモデル数、タイル数、生きている WebSocket 数 (呼び出し側から getter を注入)
 * - `performance.memory` (Chrome のみ。無ければ記録しない)
 */

export interface SamplerOptions {
  registry: Registry;
  intervalMs: number;
  emit: (record: MetricRecord) => void;
  liveSockets: () => number;
  tiles: () => number;
}

interface PerformanceMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
}

const mb = (bytes: number): number => Math.round((bytes / 1048576) * 100) / 100;

export function startSamplers(opts: SamplerOptions): () => void {
  const { registry, emit } = opts;
  let webglLost = 0;
  const onContextLost = () => {
    webglLost += 1;
  };
  document.addEventListener('webglcontextlost', onContextLost, true);

  function sample(): void {
    if (document.visibilityState !== 'visible') return;
    const t0 = performance.now();
    try {
      registry.gauge('xterm.instances', document.querySelectorAll('.xterm').length);
      registry.gauge('canvas.count', document.querySelectorAll('.xterm-screen canvas').length);
      registry.gauge('webgl.lost', webglLost);
      registry.gauge('monaco.models', monaco.editor.getModels().length);
      registry.gauge('tiles', opts.tiles());
      registry.gauge('ws.links', opts.liveSockets());
      const memory = (performance as unknown as { memory?: PerformanceMemory }).memory;
      if (memory && typeof memory.usedJSHeapSize === 'number') {
        registry.gauge('js.heap.used', mb(memory.usedJSHeapSize));
        registry.gauge('js.heap.total', mb(memory.totalJSHeapSize));
      }
    } catch {
      // DOM/Monaco が使えない状態でも snapshot 自体は出す
    }
    const snap = registry.snapshot();
    emit({ k: 'snapshot', t: Date.now(), act: document.hasFocus() ? 'active' : 'inactive', ...snap });
    registry.observe('metrics.self.serialize', performance.now() - t0);
  }

  const timer = setInterval(sample, opts.intervalMs);
  return () => {
    clearInterval(timer);
    document.removeEventListener('webglcontextlost', onContextLost, true);
  };
}
