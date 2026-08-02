import { describe, expect, it } from 'vitest';
import { locateSession, normPath } from './sessionLocate';
import type { ActiveRepo, ArchivedRepo, Repo, Worktree } from './types';

function worktree(path: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    path,
    head: 'abc123',
    branch: 'main',
    isMain: true,
    locked: false,
    status: null,
    agent: { status: 'none', terminalId: null },
    ...overrides,
  };
}

function activeRepo(id: string, worktreePaths: string[]): ActiveRepo {
  return {
    id,
    path: `C:/repos/${id}`,
    name: id,
    pinned: false,
    archived: false,
    gitMode: 'root',
    worktrees: worktreePaths.map((p) => worktree(p)),
    error: null,
  };
}

function archivedRepo(id: string, knownWorktreePaths: string[] = []): ArchivedRepo {
  return {
    id,
    path: `C:/repos/${id}`,
    name: id,
    pinned: false,
    archived: true,
    knownWorktreePaths,
  };
}

describe('locateSession', () => {
  it('resolves an exact match against an active repo worktree path', () => {
    const repo = activeRepo('a', ['C:/repos/a']);
    const repos: Repo[] = [repo];
    const result = locateSession(repos, 'C:/repos/a');
    expect(result).toEqual({ kind: 'worktree', repo, worktree: repo.worktrees[0] });
  });

  it('tolerates backslash vs forward-slash separator differences', () => {
    const repos: Repo[] = [activeRepo('a', ['C:/repos/a/wt'])];
    expect(locateSession(repos, 'C:\\repos\\a\\wt')?.kind).toBe('worktree');
  });

  it('tolerates case differences', () => {
    const repos: Repo[] = [activeRepo('a', ['C:/Repos/A/WT'])];
    expect(locateSession(repos, 'c:/repos/a/wt')?.kind).toBe('worktree');
  });

  it('tolerates a trailing slash', () => {
    const repos: Repo[] = [activeRepo('a', ['C:/repos/a/wt'])];
    expect(locateSession(repos, 'C:/repos/a/wt/')?.kind).toBe('worktree');
  });

  it('resolves an exact match against an archived repo knownWorktreePaths entry', () => {
    const repo = archivedRepo('b', ['C:/repos/b.worktrees/feature']);
    const repos: Repo[] = [repo];
    const result = locateSession(repos, 'C:/repos/b.worktrees/feature');
    expect(result).toEqual({ kind: 'archived', repo });
  });

  it('returns null for an archived repo whose knownWorktreePaths is empty', () => {
    const repos: Repo[] = [archivedRepo('b', [])];
    expect(locateSession(repos, 'C:/repos/b.worktrees/feature')).toBeNull();
  });

  it(
    'does not throw and returns null when knownWorktreePaths is entirely missing ' +
      "(wire contract can't be enforced by TS — server/index.ts's res.json(result) has no " +
      'type annotation and is assembled in multiple places; a real response missing this key ' +
      'must degrade to [] rather than crash the bell-rendering path that calls sessionLabel)',
    () => {
      const malformed: Partial<ArchivedRepo> = archivedRepo('b', []);
      delete malformed.knownWorktreePaths;
      const repos: Repo[] = [malformed as unknown as Repo];
      expect(() => locateSession(repos, 'C:/repos/b.worktrees/feature')).not.toThrow();
      expect(locateSession(repos, 'C:/repos/b.worktrees/feature')).toBeNull();
    },
  );

  it(
    "returns null for an archived repo's own path when it is not itself listed in " +
      'knownWorktreePaths (proves containment/prefix matching is not used, per D4)',
    () => {
      const repos: Repo[] = [archivedRepo('b', ['C:/repos/b.worktrees/feature'])];
      expect(locateSession(repos, 'C:/repos/b')).toBeNull();
      expect(locateSession(repos, 'C:/repos/b/sub/path')).toBeNull();
    },
  );

  it(
    'returns null when cwd shares a string prefix with (but is not equal to) an archived ' +
      "repo's knownWorktreePaths entry — sibling directory and subdirectory cases. " +
      'Reviewer mutation probe: rewriting sessionLocate.ts:45 from `normPath(path) === key` to ' +
      '`key.startsWith(normPath(path))` must turn this test red. The pre-existing ' +
      '"proves containment/prefix matching is not used" test above does not catch that mutation ' +
      '— it only exercises cwd *shorter than* the knownWorktreePaths entry ' +
      '(repo.path vs. a longer .worktrees entry), so `key.startsWith(longerEntry)` is false there ' +
      'regardless of the bug. This test uses cwd *longer than* the entry while sharing its prefix, ' +
      'which is exactly the case `startsWith` would wrongly accept.',
    () => {
      const repos: Repo[] = [archivedRepo('b', ['C:/repos/proj'])];
      // sibling: 'proj-old' shares the string prefix 'proj' but is a different directory
      expect(locateSession(repos, 'C:/repos/proj-old/sub')).toBeNull();
      // subdirectory: under 'proj' but not the entry itself
      expect(locateSession(repos, 'C:/repos/proj/src')).toBeNull();
    },
  );

  it(
    'returns null when cwd shares a string prefix with (but is not equal to) an active repo ' +
      'worktree path — same mutation probe as above, applied to Tier 1 (sessionLocate.ts:34)',
    () => {
      const repos: Repo[] = [activeRepo('a', ['C:/repos/proj'])];
      expect(locateSession(repos, 'C:/repos/proj-old/sub')).toBeNull();
    },
  );

  it('returns null when nothing matches', () => {
    const repos: Repo[] = [
      activeRepo('a', ['C:/repos/a']),
      archivedRepo('b', ['C:/repos/b.worktrees/feature']),
    ];
    expect(locateSession(repos, 'C:/somewhere/else')).toBeNull();
  });
});

describe('normPath', () => {
  it('lowercases, normalizes separators to "/", and strips trailing slashes', () => {
    expect(normPath('C:\\Repos\\A\\')).toBe('c:/repos/a');
  });
});
