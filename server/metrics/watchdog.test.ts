import { describe, expect, it } from 'vitest';
import { Registry, type MetricRecord } from './registry.js';
import { startWatchdog } from './watchdog.js';

// 実時間で main をブロックして Worker が気付くことを確かめる (陽性) と、ブロックしなければ
// 何も出ないこと (陰性対照) の 2 つ。
describe('startWatchdog', () => {
  it('reports a hang after the main thread blocks longer than stallMs, and stays quiet otherwise', async () => {
    const reg = new Registry();
    reg.enabled = true;
    const events: MetricRecord[] = [];
    reg.onEvent = (r) => events.push(r);
    const dog = startWatchdog(reg, { stallMs: 300, heartbeatMs: 50, checkMs: 100 });
    expect(dog).not.toBeNull();
    try {
      await new Promise((r) => setTimeout(r, 400));
      expect(events).toEqual([]); // 陰性対照: ブロックしていない
      const end = Date.now() + 600;
      while (Date.now() < end) {
        /* block */
      }
      await new Promise((r) => setTimeout(r, 400));
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0]).toMatchObject({ k: 'hang' });
      expect(events[0].ms).toBeGreaterThanOrEqual(300);
      expect(Array.isArray(events[0].recent)).toBe(true);
    } finally {
      dog?.stop();
    }
  }, 10_000);
});
