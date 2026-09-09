import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createJsonlSink } from './sink.js';

// 実 ~/.prontella には触れない: os.tmpdir() 配下の使い捨てディレクトリーだけを使う。
describe('createJsonlSink', () => {
  let dir: string;

  beforeEach(() => {
    dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prontella-sink-')), 'metrics', 'dev');
  });

  afterEach(() => {
    fs.rmSync(path.dirname(path.dirname(dir)), { recursive: true, force: true });
  });

  function lines(file: string): string[] {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l !== '');
  }

  it('creates the directory lazily and appends one line per write on flush', async () => {
    const sink = createJsonlSink({ dir, flushMs: 100_000, pid: 42, now: () => Date.UTC(2026, 8, 9, 12) });
    expect(fs.existsSync(dir)).toBe(false);
    sink.write('{"k":"a"}');
    sink.write('{"k":"b"}');
    expect(fs.existsSync(dir)).toBe(false); // write は I/O しない
    await sink.flush();
    const file = path.join(dir, '2026-09-09.42.jsonl');
    expect(lines(file)).toEqual(['{"k":"a"}', '{"k":"b"}']);
    expect(sink.stats()).toMatchObject({ written: 2, dropped: 0, flushErrors: 0, file });
    sink.close();
  });

  it('close() flushes synchronously and rejects later writes', () => {
    const sink = createJsonlSink({ dir, pid: 7, now: () => Date.UTC(2026, 0, 2) });
    sink.write('{"k":"x"}');
    sink.close();
    expect(lines(path.join(dir, '2026-01-02.7.jsonl'))).toEqual(['{"k":"x"}']);
    sink.write('{"k":"late"}');
    sink.close();
    expect(lines(path.join(dir, '2026-01-02.7.jsonl'))).toEqual(['{"k":"x"}']);
  });

  it('drops the oldest lines beyond maxQueue and counts them', async () => {
    const sink = createJsonlSink({ dir, flushMs: 100_000, maxQueue: 3, pid: 1, now: () => Date.UTC(2026, 0, 1) });
    for (let i = 0; i < 5; i++) sink.write(`{"i":${i}}`);
    await sink.flush();
    expect(lines(path.join(dir, '2026-01-01.1.jsonl'))).toEqual(['{"i":2}', '{"i":3}', '{"i":4}']);
    expect(sink.stats()).toMatchObject({ written: 3, dropped: 2 });
    sink.close();
  });

  it('rotates to a -N file once the current file exceeds maxFileBytes, and by date', async () => {
    let t = Date.UTC(2026, 0, 1);
    const sink = createJsonlSink({ dir, flushMs: 100_000, maxFileBytes: 20, pid: 5, now: () => t });
    sink.write('{"a":1234567890}'); // 17 bytes + \n = 18 → まだ 20 未満
    await sink.flush();
    sink.write('{"b":2}'); // 18 + 8 = 26 ≥ 20 → 次の flush からローテート
    await sink.flush();
    sink.write('{"c":3}');
    await sink.flush();
    expect(lines(path.join(dir, '2026-01-01.5.jsonl'))).toEqual(['{"a":1234567890}', '{"b":2}']);
    expect(lines(path.join(dir, '2026-01-01.5-1.jsonl'))).toEqual(['{"c":3}']);
    t = Date.UTC(2026, 0, 2);
    sink.write('{"d":4}');
    await sink.flush();
    expect(lines(path.join(dir, '2026-01-02.5.jsonl'))).toEqual(['{"d":4}']);
    sink.close();
  });

  it('continues from the existing size of a pre-existing file', async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '2026-01-01.9.jsonl'), 'x'.repeat(30) + '\n');
    const sink = createJsonlSink({ dir, flushMs: 100_000, maxFileBytes: 20, pid: 9, now: () => Date.UTC(2026, 0, 1) });
    sink.write('{"a":1}');
    await sink.flush(); // 既存 31 バイト ≥ 20 なので最初の書き込みからローテート
    expect(lines(path.join(dir, '2026-01-01.9-1.jsonl'))).toEqual(['{"a":1}']);
    sink.close();
  });

  it('enforces the directory cap by deleting the oldest files but never the current one', async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '2025-12-30.1.jsonl'), 'a'.repeat(50));
    fs.writeFileSync(path.join(dir, '2025-12-31.1.jsonl'), 'b'.repeat(50));
    const sink = createJsonlSink({ dir, flushMs: 100_000, maxDirBytes: 60, pid: 1, now: () => Date.UTC(2026, 0, 1) });
    sink.write('{"a":1}');
    await sink.flush();
    expect(fs.existsSync(path.join(dir, '2025-12-30.1.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '2025-12-31.1.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '2026-01-01.1.jsonl'))).toBe(true);
    sink.close();
  });

  it('coalesces a flush requested while another is in flight', async () => {
    const sink = createJsonlSink({ dir, flushMs: 100_000, pid: 3, now: () => Date.UTC(2026, 0, 1) });
    sink.write('{"a":1}');
    const first = sink.flush();
    sink.write('{"b":2}');
    const second = sink.flush();
    expect(second).toBe(first);
    await first;
    // 合流した 2 本目は最初の flush の完了後に自動で走る
    await new Promise((r) => setTimeout(r, 50));
    expect(lines(path.join(dir, '2026-01-01.3.jsonl'))).toEqual(['{"a":1}', '{"b":2}']);
    sink.close();
  });

  it('counts a failed append as flushErrors + dropped and keeps running', async () => {
    // dir をファイルにして mkdir を失敗させる
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.writeFileSync(dir, 'not a dir');
    const sink = createJsonlSink({ dir, flushMs: 100_000, pid: 3, now: () => Date.UTC(2026, 0, 1) });
    sink.write('{"a":1}');
    await sink.flush();
    expect(sink.stats()).toMatchObject({ written: 0, dropped: 1, flushErrors: 1 });
    sink.close();
  });
});
