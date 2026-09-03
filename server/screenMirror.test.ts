import { describe, expect, it } from 'vitest';
import { ScreenMirror } from './screenMirror.js';

const ESC = '\x1b';

function snapshot(m: ScreenMirror): Promise<string> {
  return new Promise((resolve) => m.snapshot(resolve));
}

describe('ScreenMirror', () => {
  it('serializes written text after the write queue drains', async () => {
    const m = new ScreenMirror(40, 10, 100);
    m.write('hello\r\nworld\r\n');
    const out = await snapshot(m);
    expect(out).toContain('hello');
    expect(out).toContain('world');
    m.dispose();
  });

  it('collapses repeated in-place redraws to what is visible', async () => {
    const m = new ScreenMirror(80, 24, 1000);
    // Ink 風: 5 行のブロックを 200 回描き直す (生出力なら ~200 × 5 × 80 文字)
    let raw = '';
    for (let i = 0; i < 5; i++) raw += `row ${i}`.padEnd(80) + '\r\n';
    m.write(raw);
    for (let t = 1; t <= 200; t++) {
      let frame = `${ESC}[5A`;
      // 可視幅を 80 に揃えてから色を付ける (ESC を含めて pad すると桁溢れで折り返す)
      for (let i = 0; i < 5; i++) frame += `${ESC}[3${i + 1}m${`row ${i} tick ${t}`.padEnd(80)}${ESC}[0m\r\n`;
      raw += frame;
      m.write(frame);
    }
    const out = await snapshot(m);
    expect(out).toContain('tick 200');
    expect(out).not.toContain('tick 199');
    expect(out.length).toBeLessThan(raw.length / 20);
    m.dispose();
  });

  it('keeps tracked DEC modes (bracketed paste) in the snapshot', async () => {
    const m = new ScreenMirror(40, 5, 10);
    m.write(`${ESC}[?2004h`);
    const out = await snapshot(m);
    expect(out).toContain(`${ESC}[?2004h`);
    m.dispose();
  });

  it('follows resize', async () => {
    const m = new ScreenMirror(40, 5, 10);
    m.resize(100, 30);
    expect(m.cols).toBe(100);
    expect(m.rows).toBe(30);
    m.write('x');
    expect((await snapshot(m)).includes('x')).toBe(true);
    m.dispose();
  });

  it('ignores writes and snapshots after dispose', async () => {
    const m = new ScreenMirror(40, 5, 10);
    m.dispose();
    expect(() => m.write('a')).not.toThrow();
    let called = false;
    m.snapshot(() => {
      called = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(called).toBe(false);
  });
});
