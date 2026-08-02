import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RepoConfig } from './config.js';
import { applyFlags, normalizeRepoConfig, reconcileOrder, sortBySection } from './repoOrder.js';

// normalizeRepoConfig の id 導出と同じロジック(config.ts の repoId と同一)。
// テスト側でも独立に導出できるよう複製する(repoOrder.ts が内部で使う deriveId は非 export)。
function expectedId(repoPath: string): string {
  return Buffer.from(path.resolve(repoPath)).toString('base64url');
}

function repo(overrides: Partial<RepoConfig> & { path: string }): RepoConfig {
  return { id: expectedId(overrides.path), name: path.basename(overrides.path), ...overrides };
}

describe('normalizeRepoConfig', () => {
  it('既存形式(新フィールドを持たない現行ユーザーの config)をそのまま通す', () => {
    const input = [{ id: expectedId('/repos/x'), path: '/repos/x', name: 'X' }];
    const result = normalizeRepoConfig(input);
    expect(result).toEqual([{ id: expectedId('/repos/x'), path: '/repos/x', name: 'X' }]);
    expect(result[0]).not.toHaveProperty('pinned');
    expect(result[0]).not.toHaveProperty('archived');
  });

  it('id が欠落/不一致のエントリーを path から復元する', () => {
    const input = [{ id: 'WRONG-ID', path: '/repos/y', name: 'Y' }];
    const result = normalizeRepoConfig(input);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(expectedId('/repos/y'));

    const missingId = normalizeRepoConfig([{ path: '/repos/y2', name: 'Y2' }]);
    expect(missingId[0].id).toBe(expectedId('/repos/y2'));
  });

  it('name 欠落を path のベース名から復元する', () => {
    const result = normalizeRepoConfig([{ path: '/repos/z-name' }]);
    expect(result[0].name).toBe('z-name');
  });

  it('pinned && archived が両立するときは archived を優先し pinned を落とす', () => {
    const result = normalizeRepoConfig([
      { id: expectedId('/repos/w'), path: '/repos/w', name: 'W', pinned: true, archived: true },
    ]);
    expect(result[0].archived).toBe(true);
    expect(result[0]).not.toHaveProperty('pinned');
  });

  it('pinned/archived が非 boolean のときは false 扱いにし、キー自体を書き戻さない', () => {
    const result = normalizeRepoConfig([
      { id: expectedId('/repos/v'), path: '/repos/v', name: 'V', pinned: 'true', archived: 1 },
    ]);
    expect(result[0]).not.toHaveProperty('pinned');
    expect(result[0]).not.toHaveProperty('archived');
  });

  it('未知キーを spread で保持する', () => {
    const result = normalizeRepoConfig([
      { id: expectedId('/repos/u'), path: '/repos/u', name: 'U', futureFlag: 'kept' },
    ]);
    expect(result[0].futureFlag).toBe('kept');
  });

  it('path が非空文字列でないエントリーを除去する(修復ではなく除去は最後の手段)', () => {
    const result = normalizeRepoConfig([
      { id: 'a', name: 'no-path' }, // path 欠落
      { id: 'b', path: '', name: 'empty-path' }, // 空文字
      { id: 'c', path: 123, name: 'numeric-path' }, // 非文字列
      { id: 'd', path: '/repos/ok', name: 'OK' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('/repos/ok');
  });

  it('id 重複は最初の 1 つを採用する(同一パスに解決される 2 エントリー)', () => {
    const result = normalizeRepoConfig([
      { id: expectedId('/repos/dup'), path: '/repos/dup', name: 'First' },
      { id: 'anything', path: '/repos/dup', name: 'Second' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('First');
  });

  it('非配列の入力は空配列を返す', () => {
    expect(normalizeRepoConfig(null)).toEqual([]);
    expect(normalizeRepoConfig(undefined)).toEqual([]);
    expect(normalizeRepoConfig({})).toEqual([]);
    expect(normalizeRepoConfig('not-an-array')).toEqual([]);
    expect(normalizeRepoConfig(42)).toEqual([]);
  });

  it('配列要素自体が非オブジェクトのときはそのエントリーだけ落とす', () => {
    const result = normalizeRepoConfig([
      null,
      42,
      'str',
      ['nested', 'array'],
      { id: expectedId('/repos/ok2'), path: '/repos/ok2', name: 'OK2' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('/repos/ok2');
  });
});

describe('sortBySection', () => {
  it('pinned → normal → archived の順に安定分割する(同一セクション内の相対順を維持)', () => {
    const p1 = repo({ path: '/p1', pinned: true });
    const n1 = repo({ path: '/n1' });
    const a1 = repo({ path: '/a1', archived: true });
    const p2 = repo({ path: '/p2', pinned: true });
    const n2 = repo({ path: '/n2' });
    const a2 = repo({ path: '/a2', archived: true });

    // わざと入り乱れた入力順にする
    const input = [n1, a1, p1, n2, p2, a2];
    const result = sortBySection(input);
    expect(result.map((r) => r.path)).toEqual(['/p1', '/p2', '/n1', '/n2', '/a1', '/a2']);
  });
});

describe('reconcileOrder', () => {
  const current: RepoConfig[] = [
    repo({ path: '/a', id: 'a', pinned: true }),
    repo({ path: '/b', id: 'b' }),
    repo({ path: '/c', id: 'c', archived: true }),
  ];

  it('完全一致するリクエストはそのまま反映する', () => {
    const result = reconcileOrder(current, ['a', 'b', 'c']);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.repos.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('config に無い未知 id は落とす', () => {
    const result = reconcileOrder(current, ['a', 'unknown', 'b', 'c']);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.repos.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('リクエストに無い id は現在の相対順を保って末尾に追加する', () => {
    const result = reconcileOrder(current, ['c', 'a']); // b が欠落
    expect(result.ok).toBe(true);
    // b を末尾に追加した後、sortBySection で再分割される(a=pinned, b=normal, c=archived)
    if (result.ok) expect(result.repos.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('リクエスト内の重複 id は最初の 1 つを採用する', () => {
    const result = reconcileOrder(current, ['b', 'b', 'a', 'c']);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.repos.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('非配列は 400 相当の ok:false を返す', () => {
    expect(reconcileOrder(current, 'not-an-array').ok).toBe(false);
    expect(reconcileOrder(current, { order: ['a'] }).ok).toBe(false);
    expect(reconcileOrder(current, null).ok).toBe(false);
  });

  it('非文字列要素を含む配列は ok:false を返す', () => {
    expect(reconcileOrder(current, ['a', 1, 'c']).ok).toBe(false);
    expect(reconcileOrder(current, ['a', null, 'c']).ok).toBe(false);
    expect(reconcileOrder(current, ['a', { id: 'b' }, 'c']).ok).toBe(false);
  });

  it('空配列は全件が現順序で末尾に追加される(= 既に正規化済みなら無変更)', () => {
    const result = reconcileOrder(current, []);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.repos.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('長さ上限(Math.max(1000, current.length))を超えると ok:false を返す', () => {
    const longRequest = Array.from({ length: 1001 }, (_, i) => `id-${i}`);
    const result = reconcileOrder(current, longRequest);
    expect(result.ok).toBe(false);

    // current が 1000 件を超える場合は current.length が上限になる
    const bigCurrent: RepoConfig[] = Array.from({ length: 1500 }, (_, i) =>
      repo({ path: `/big-${i}`, id: `big-${i}` }));
    const within = Array.from({ length: 1500 }, (_, i) => `big-${i}`);
    expect(reconcileOrder(bigCurrent, within).ok).toBe(true);
    const over = [...within, 'extra-one-over-limit'];
    expect(reconcileOrder(bigCurrent, over).ok).toBe(false);
  });

  it('__proto__ / constructor / toString を id に含む入力でも汚染されず正しく突合する', () => {
    const poisoned: RepoConfig[] = [
      repo({ path: '/proto', id: '__proto__' }),
      repo({ path: '/ctor', id: 'constructor' }),
      repo({ path: '/tostr', id: 'toString' }),
    ];
    const result = reconcileOrder(poisoned, ['toString', '__proto__', 'constructor']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.repos.map((r) => r.id).sort()).toEqual(['__proto__', 'constructor', 'toString'].sort());
      expect(result.repos).toHaveLength(3);
    }
    // Object.prototype 自体が汚染されていないことも確認
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('全順列・全組み合わせを流しても current の 3 件が 1 件も失われない(id プール5要素・長さ0〜3)', () => {
    const pool = ['a', 'b', 'c', 'z', '__proto__'];
    const sequences = allSequences(pool, 3);
    // choose(5,0)*0! + choose(5,1)*1! + choose(5,2)*2! + choose(5,3)*3! = 1+5+20+60 = 86
    expect(sequences.length).toBe(86);

    for (const seq of sequences) {
      const result = reconcileOrder(current, seq);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.repos.map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
      expect(result.repos).toHaveLength(3);
    }
  });
});

/** pool から重複無しで選んだ、長さ 0〜maxLen の全順列を列挙する(順列 = 順序も区別)。 */
function allSequences(pool: string[], maxLen: number): string[][] {
  const results: string[][] = [];
  function permute(remaining: string[], current: string[], targetLen: number): void {
    if (current.length === targetLen) {
      results.push(current.slice());
      return;
    }
    for (let i = 0; i < remaining.length; i++) {
      const next = remaining.slice();
      const [item] = next.splice(i, 1);
      current.push(item);
      permute(next, current, targetLen);
      current.pop();
    }
  }
  for (let len = 0; len <= maxLen; len++) {
    permute(pool.slice(), [], len);
  }
  return results;
}

describe('applyFlags', () => {
  function makeRepos(): RepoConfig[] {
    return [
      repo({ path: '/p1', id: 'p1', pinned: true }),
      repo({ path: '/n1', id: 'n1' }),
      repo({ path: '/n2', id: 'n2' }),
      repo({ path: '/a1', id: 'a1', archived: true }),
    ];
  }

  it('通常 → ピン留めでピン群の末尾に着地する', () => {
    const result = applyFlags(makeRepos(), 'n2', { pinned: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.repos.map((r) => r.id)).toEqual(['p1', 'n2', 'n1', 'a1']);
    expect(result.repos.find((r) => r.id === 'n2')?.pinned).toBe(true);
  });

  it('ピン → アーカイブでピンが外れる', () => {
    const result = applyFlags(makeRepos(), 'p1', { archived: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const target = result.repos.find((r) => r.id === 'p1');
    expect(target?.archived).toBe(true);
    expect(target).not.toHaveProperty('pinned');
  });

  it('アーカイブ → 解除で通常群の末尾に着地する', () => {
    const result = applyFlags(makeRepos(), 'a1', { archived: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.repos.map((r) => r.id)).toEqual(['p1', 'n1', 'n2', 'a1']);
    const target = result.repos.find((r) => r.id === 'a1');
    expect(target).not.toHaveProperty('archived');
    expect(target).not.toHaveProperty('pinned');
  });

  it('未知 id は ok:false を返す', () => {
    const result = applyFlags(makeRepos(), 'does-not-exist', { pinned: true });
    expect(result.ok).toBe(false);
  });

  it('非 boolean な値は ok:false を返す', () => {
    expect(applyFlags(makeRepos(), 'n1', { pinned: 'true' }).ok).toBe(false);
    expect(applyFlags(makeRepos(), 'n1', { archived: 1 }).ok).toBe(false);
    expect(applyFlags(makeRepos(), 'n1', { pinned: null }).ok).toBe(false);
  });

  it('pinned と archived の同時指定は ok:false を返す', () => {
    const result = applyFlags(makeRepos(), 'n1', { pinned: true, archived: true });
    expect(result.ok).toBe(false);
  });

  it('pinned/archived がどちらも未指定(空ボディ)なら ok:false を返す(不要な保存を防ぐ)', () => {
    expect(applyFlags(makeRepos(), 'n1', {}).ok).toBe(false);
    expect(applyFlags(makeRepos(), 'n1', { pinned: undefined, archived: undefined }).ok).toBe(false);
  });
});
