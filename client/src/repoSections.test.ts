import { describe, expect, it } from 'vitest';
import { applyRepoMeta, isActive, isArchived, moveByOffset, moveWithinSection, sectionize } from './repoSections';
import type { ActiveRepo, ArchivedRepo, Repo, RepoMeta, Worktree } from './types';

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

function activeRepo(id: string, overrides: Partial<ActiveRepo> = {}): ActiveRepo {
  return {
    id,
    path: `C:/repos/${id}`,
    name: id,
    pinned: false,
    archived: false,
    gitMode: 'root',
    worktrees: [worktree(`C:/repos/${id}`)],
    error: null,
    ...overrides,
  };
}

function archivedRepo(id: string, overrides: Partial<ArchivedRepo> = {}): ArchivedRepo {
  return {
    id,
    path: `C:/repos/${id}`,
    name: id,
    pinned: false,
    archived: true,
    knownWorktreePaths: [],
    ...overrides,
  };
}

describe('isActive / isArchived', () => {
  it('classifies an ActiveRepo as active and an ArchivedRepo as archived', () => {
    const active = activeRepo('a');
    const archived = archivedRepo('b');
    expect(isActive(active)).toBe(true);
    expect(isArchived(active)).toBe(false);
    expect(isActive(archived)).toBe(false);
    expect(isArchived(archived)).toBe(true);
  });

  it(
    'treats an object with a missing "archived" key as active ' +
      '(D0 safety net: a server that forgets to set archived must not empty the sidebar)',
    () => {
      const malformed: Partial<ActiveRepo> = activeRepo('c');
      delete malformed.archived;
      expect(isActive(malformed as unknown as Repo)).toBe(true);
      expect(isArchived(malformed as unknown as Repo)).toBe(false);
    },
  );
});

describe('sectionize', () => {
  it('splits into pinned/normal/archived while preserving array order within each group', () => {
    const repos: Repo[] = [
      activeRepo('n1'),
      activeRepo('p1', { pinned: true }),
      archivedRepo('ar1'),
      activeRepo('n2'),
      activeRepo('p2', { pinned: true }),
      archivedRepo('ar2'),
    ];
    const result = sectionize(repos);
    expect(result.pinned.map((r) => r.id)).toEqual(['p1', 'p2']);
    expect(result.normal.map((r) => r.id)).toEqual(['n1', 'n2']);
    expect(result.archived.map((r) => r.id)).toEqual(['ar1', 'ar2']);
  });

  it('returns empty arrays for an empty input', () => {
    expect(sectionize([])).toEqual({ pinned: [], normal: [], archived: [] });
  });

  it('handles an all-archived input', () => {
    const repos: Repo[] = [archivedRepo('a'), archivedRepo('b')];
    const result = sectionize(repos);
    expect(result.pinned).toEqual([]);
    expect(result.normal).toEqual([]);
    expect(result.archived.map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('moveWithinSection', () => {
  const repos: Repo[] = [
    activeRepo('n1'),
    activeRepo('n2'),
    activeRepo('n3'),
    activeRepo('p1', { pinned: true }),
    archivedRepo('a1'),
  ];

  it('moves within the same section, before the target', () => {
    expect(moveWithinSection(repos, 'n3', 'n1', 'before')).toEqual(['n3', 'n1', 'n2', 'p1', 'a1']);
  });

  it('moves within the same section, after the target', () => {
    expect(moveWithinSection(repos, 'n1', 'n3', 'after')).toEqual(['n2', 'n3', 'n1', 'p1', 'a1']);
  });

  it('returns null for a cross-section move', () => {
    expect(moveWithinSection(repos, 'n1', 'p1', 'before')).toBeNull();
  });

  it('returns null for moving onto itself', () => {
    expect(moveWithinSection(repos, 'n1', 'n1', 'before')).toBeNull();
  });

  it('returns null for an unknown dragged id', () => {
    expect(moveWithinSection(repos, 'ghost', 'n1', 'before')).toBeNull();
  });

  it('returns null for an unknown target id', () => {
    expect(moveWithinSection(repos, 'n1', 'ghost', 'before')).toBeNull();
  });

  it('the resulting id list contains every input repo exactly once', () => {
    const result = moveWithinSection(repos, 'n2', 'n1', 'after');
    expect(result).not.toBeNull();
    expect([...result!].sort()).toEqual(repos.map((r) => r.id).sort());
  });
});

describe('moveByOffset', () => {
  const repos: Repo[] = [
    activeRepo('n1'),
    activeRepo('n2'),
    activeRepo('n3'),
    activeRepo('p1', { pinned: true }),
    archivedRepo('a1'),
  ];

  it('returns null when already at the top of its section', () => {
    expect(moveByOffset(repos, 'n1', -1)).toBeNull();
  });

  it('returns null when already at the bottom of its section', () => {
    expect(moveByOffset(repos, 'n3', 1)).toBeNull();
  });

  it('moves down by one within the section', () => {
    expect(moveByOffset(repos, 'n1', 1)).toEqual(['n2', 'n1', 'n3', 'p1', 'a1']);
  });

  it('moves up by one within the section', () => {
    expect(moveByOffset(repos, 'n3', -1)).toEqual(['n1', 'n3', 'n2', 'p1', 'a1']);
  });

  it('never crosses a section boundary (a single-member section has no valid offset target)', () => {
    expect(moveByOffset(repos, 'p1', 1)).toBeNull();
    expect(moveByOffset(repos, 'p1', -1)).toBeNull();
  });
});

describe('applyRepoMeta', () => {
  it('reorders local repos to match the meta order', () => {
    const repos: Repo[] = [activeRepo('a'), activeRepo('b'), activeRepo('c')];
    const meta: RepoMeta[] = [
      { id: 'c', pinned: false, archived: false },
      { id: 'a', pinned: false, archived: false },
      { id: 'b', pinned: false, archived: false },
    ];
    const { repos: result, needsRefresh } = applyRepoMeta(repos, meta);
    expect(result.map((r) => r.id)).toEqual(['c', 'a', 'b']);
    expect(needsRefresh).toBe(false);
  });

  it('converts an active repo to archived locally (knownWorktreePaths: [])', () => {
    const repos: Repo[] = [activeRepo('a')];
    const meta: RepoMeta[] = [{ id: 'a', pinned: false, archived: true }];
    const { repos: result, needsRefresh } = applyRepoMeta(repos, meta);
    expect(result).toEqual([
      { id: 'a', path: 'C:/repos/a', name: 'a', pinned: false, archived: true, knownWorktreePaths: [] },
    ]);
    expect(needsRefresh).toBe(false);
  });

  it('excludes an archived-to-active transition from the result and reports needsRefresh', () => {
    const repos: Repo[] = [archivedRepo('a')];
    const meta: RepoMeta[] = [{ id: 'a', pinned: false, archived: false }];
    const { repos: result, needsRefresh } = applyRepoMeta(repos, meta);
    expect(result).toEqual([]);
    expect(needsRefresh).toBe(true);
  });

  it('does not set needsRefresh for a pinned-only change on an active repo', () => {
    const repos: Repo[] = [activeRepo('a', { pinned: false })];
    const meta: RepoMeta[] = [{ id: 'a', pinned: true, archived: false }];
    const { repos: result, needsRefresh } = applyRepoMeta(repos, meta);
    expect(needsRefresh).toBe(false);
    expect(result[0]).toMatchObject({ id: 'a', pinned: true, archived: false });
  });

  it('drops local repos that are absent from meta', () => {
    const repos: Repo[] = [activeRepo('a'), activeRepo('b')];
    const meta: RepoMeta[] = [{ id: 'a', pinned: false, archived: false }];
    const { repos: result } = applyRepoMeta(repos, meta);
    expect(result.map((r) => r.id)).toEqual(['a']);
  });

  it('ignores meta ids that are absent locally', () => {
    const repos: Repo[] = [activeRepo('a')];
    const meta: RepoMeta[] = [
      { id: 'ghost', pinned: false, archived: false },
      { id: 'a', pinned: false, archived: false },
    ];
    const { repos: result } = applyRepoMeta(repos, meta);
    expect(result.map((r) => r.id)).toEqual(['a']);
  });
});
