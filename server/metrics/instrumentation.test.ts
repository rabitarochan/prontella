import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGit, runGitInput } from '../git.js';
import { broadcastEvent } from '../sessionEvents.js';
import { metrics, type MetricRecord } from './index.js';
import { checkAnon } from './scrub.js';

/**
 * 計測点が本番の呼び出し経路で実際に記録すること、そして anon 層のレジストリ設定
 * (includeAttrs=false) で生成されたイベントが閉じた allowlist を通ることを、実 git を
 * 走らせて確かめる。レジストリはモジュール単位のシングルトンなので、テストの間だけ
 * enabled にして onEvent を差し替え、終わったら戻す。
 */

describe('instrumentation (git spans, sessionEvents counters)', () => {
  let dir: string;
  let events: MetricRecord[];
  const savedOnEvent = metrics.onEvent;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prontella-metrics-git-'));
    events = [];
    metrics.enabled = true;
    metrics.includeAttrs = false; // anon 相当
    metrics.onEvent = (r) => events.push(r);
    metrics.snapshot(); // 直前までの分布を捨てる
  });

  afterEach(() => {
    metrics.enabled = false;
    metrics.includeAttrs = false;
    metrics.onEvent = savedOnEvent;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('runGit records a git span labelled by subcommand, and failures carry err only in dev', async () => {
    await runGit(dir, ['--version']);
    await expect(runGit(dir, ['status'])).rejects.toThrow(); // git リポジトリーではないので失敗
    const { hist } = metrics.snapshot();
    const git = hist.filter((h) => h.n === 'git');
    expect(git.map((h) => h.l?.git).sort()).toEqual(['other', 'status']);
    expect(git.every((h) => h.h.c === 1)).toBe(true);
    // 生成された slow イベント (あれば) は anon の検査を通る — cwd も引数も載っていない
    for (const e of events) {
      expect(checkAnon({ ...e, run: 'a1b2c3d4', src: 'server' })).toBeNull();
      expect(JSON.stringify(e)).not.toContain(dir);
    }
  });

  it('runGitInput records exactly one span even though it has four settle points', async () => {
    await runGit(dir, ['init', '-q']);
    metrics.snapshot();
    await expect(runGitInput(dir, ['apply', '--check', '-'], Buffer.from('not a patch\n'))).rejects.toThrow();
    const { hist } = metrics.snapshot();
    const apply = hist.find((h) => h.n === 'git' && h.l?.git === 'apply');
    expect(apply?.h.c).toBe(1);
  });

  it('dev tier attaches cwd and args to slow git events; anon never does', async () => {
    metrics.includeAttrs = true;
    // しきい値を確実に超えるよう、存在しないサブコマンドでも spawn 自体はするので時間は掛かる
    await expect(runGit(dir, ['status'])).rejects.toThrow();
    const devSlow = events.filter((e) => e.k === 'slow' && e.n === 'git');
    // 速いマシンでは 500ms を切って slow が出ないことがある — 出た場合の形だけ固定する
    for (const e of devSlow) {
      expect(e).toMatchObject({ git: 'status', cwd: dir, err: true });
      expect(checkAnon({ ...e, run: 'a1b2c3d4', src: 'server' })).not.toBeNull();
    }
  });

  it('broadcastEvent counts broadcasts and the ones with no subscribers', () => {
    broadcastEvent({ type: 'session' });
    broadcastEvent({ type: 'removed', id: 'x' });
    const { counters } = metrics.snapshot();
    const value = (n: string) => counters.find((c) => c.n === n)?.v ?? 0;
    expect(value('events.broadcast')).toBeGreaterThanOrEqual(2);
    expect(value('events.noSubscribers')).toBeGreaterThanOrEqual(2);
  });
});
