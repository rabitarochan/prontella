import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLatestThrottle } from './latestThrottle';

describe('createLatestThrottle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends only the latest value once per interval', () => {
    const sent: number[] = [];
    const t = createLatestThrottle<number>((v) => sent.push(v), 80);
    t.push(1);
    t.push(2);
    t.push(3);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(79);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([3]);
  });

  it('starts a new window after firing, so a long drag sends at most one per interval', () => {
    const sent: number[] = [];
    const t = createLatestThrottle<number>((v) => sent.push(v), 80);
    for (let i = 1; i <= 20; i++) {
      t.push(i);
      vi.advanceTimersByTime(16); // ~1 frame
    }
    // 20 frames = 320ms → windows at 80/160/240/320
    expect(sent.length).toBeGreaterThanOrEqual(3);
    expect(sent.length).toBeLessThanOrEqual(4);
    vi.advanceTimersByTime(100);
    expect(sent[sent.length - 1]).toBe(20); // trailing: the final value always arrives
  });

  it('flush sends the pending value immediately and clears the timer', () => {
    const sent: number[] = [];
    const t = createLatestThrottle<number>((v) => sent.push(v), 80);
    t.push(5);
    t.flush();
    expect(sent).toEqual([5]);
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([5]); // no duplicate from the old timer
  });

  it('flush with nothing pending is a no-op', () => {
    const sent: number[] = [];
    const t = createLatestThrottle<number>((v) => sent.push(v), 80);
    t.flush();
    expect(sent).toEqual([]);
  });

  it('cancel drops the pending value', () => {
    const sent: number[] = [];
    const t = createLatestThrottle<number>((v) => sent.push(v), 80);
    t.push(7);
    t.cancel();
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([]);
  });
});
