import { describe, expect, it, vi } from 'vitest';

// server/index.ts はモジュールスコープで実サーバーを bind する (`server.listen(PORT, ...)`)。
// このファイルを素の import で読み込むと、開発サーバーが起動中ならポート衝突
// (EADDRINUSE) が起き、空いていれば bind に成功してテストプロセスがハンドルリークで
// 終了できなくなる (pj-git-route スキル: 「supertest 等を入れると import しただけで
// 実サーバーと PTY が起動する」と同じ理由)。node:http の createServer だけを no-op
// にモックし、モジュール import 時の実バインドを防いだ上で、検証ロジックの純関数
// checkBranchRefParam だけを取り出してテストする。
vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  return {
    ...actual,
    default: {
      ...actual.default,
      createServer: () => ({ on: () => {}, listen: () => {} }),
    },
  };
});

const { checkBranchRefParam } = await import('./index.js');

describe('checkBranchRefParam', () => {
  it('accepts a normal branch name', () => {
    expect(checkBranchRefParam('feat/TICKET-001', 'branch')).toEqual({
      ok: true,
      value: 'feat/TICKET-001',
    });
  });

  it('accepts a normal Japanese branch name', () => {
    expect(checkBranchRefParam('feat/TICKET-002-別の説明', 'branch')).toEqual({
      ok: true,
      value: 'feat/TICKET-002-別の説明',
    });
  });

  it('trims surrounding whitespace on success', () => {
    expect(checkBranchRefParam('  feat/x  ', 'branch')).toEqual({ ok: true, value: 'feat/x' });
  });

  // typeof チェックが最初に効くこと (配列 body `["a","b"]` が `String(x)` で `"a,b"` に
  // 化けて素通りする既知の穴を塞ぐための回帰テスト)。
  it('rejects an array', () => {
    expect(checkBranchRefParam(['a', 'b'], 'branch').ok).toBe(false);
  });

  it('rejects a number', () => {
    expect(checkBranchRefParam(123, 'branch').ok).toBe(false);
  });

  it('rejects null', () => {
    expect(checkBranchRefParam(null, 'branch').ok).toBe(false);
  });

  it('rejects undefined', () => {
    expect(checkBranchRefParam(undefined, 'branch').ok).toBe(false);
  });

  it('rejects an object', () => {
    expect(checkBranchRefParam({ toString: () => 'feat/x' }, 'branch').ok).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(checkBranchRefParam('', 'branch').ok).toBe(false);
  });

  it('rejects a whitespace-only string', () => {
    expect(checkBranchRefParam('   ', 'branch').ok).toBe(false);
  });

  it('rejects a leading-dash value (option injection)', () => {
    expect(checkBranchRefParam('-f', 'branch').ok).toBe(false);
  });

  it('rejects an argument-injection payload', () => {
    expect(checkBranchRefParam('--upload-pack=echo pwned', 'branch').ok).toBe(false);
  });

  it('rejects a value containing a colon', () => {
    expect(checkBranchRefParam('a:b', 'remoteBranch').ok).toBe(false);
  });

  it('rejects a value containing whitespace', () => {
    expect(checkBranchRefParam('a b', 'remoteBranch').ok).toBe(false);
  });

  it('rejects a value containing ..', () => {
    expect(checkBranchRefParam('../x', 'remoteBranch').ok).toBe(false);
  });
});
