import { describe, expect, it } from 'vitest';
import type { TerminalSession } from '../types';
import { allTermGroups, makeTermGroup, type TermGroupNode } from './termGroups';
import {
  initialMonitorTermState,
  monitorGroupFor,
  orderMonitorSessions,
  sameWorktreeKey,
} from './terminalMonitor';

function session(over: Partial<TerminalSession> & { id: string }): TerminalSession {
  return {
    cwd: 'C:\\repo',
    title: 'shell',
    kind: 'pty',
    status: 'shell',
    claudeDetected: false,
    createdAt: 0,
    lastOutputAt: 0,
    statusSince: 0,
    activity: null,
    ...over,
  };
}

describe('orderMonitorSessions', () => {
  it('excludes SDK sessions', () => {
    const out = orderMonitorSessions(
      [session({ id: 'a' }), session({ id: 'b', kind: 'sdk' }), session({ id: 'c' })],
      () => 'x',
    );
    expect(out.map((e) => e.session.id)).toEqual(['a', 'c']);
  });

  it('groups by label, then createdAt, then id', () => {
    const out = orderMonitorSessions(
      [
        session({ id: 'z', cwd: 'B', createdAt: 5 }),
        session({ id: 'y', cwd: 'A', createdAt: 9 }),
        session({ id: 'x', cwd: 'A', createdAt: 2 }),
        session({ id: 'w', cwd: 'B', createdAt: 5 }),
      ],
      (s) => s.cwd,
    );
    expect(out.map((e) => `${e.label}:${e.session.id}`)).toEqual(['A:x', 'A:y', 'B:w', 'B:z']);
  });

  it('does not reorder by status', () => {
    const out = orderMonitorSessions(
      [session({ id: 'a', createdAt: 1, status: 'idle' }), session({ id: 'b', createdAt: 2, status: 'waiting' })],
      () => 'same',
    );
    expect(out.map((e) => e.session.id)).toEqual(['a', 'b']);
  });

  it('returns an empty list for no sessions', () => {
    expect(orderMonitorSessions([], () => '')).toEqual([]);
  });
});

describe('sameWorktreeKey', () => {
  it('normalizes separators, trailing slashes and case', () => {
    expect(sameWorktreeKey('C:\\Work\\Repo\\')).toBe(sameWorktreeKey('c:/work/repo'));
    expect(sameWorktreeKey('/home/u/a')).not.toBe(sameWorktreeKey('/home/u/b'));
  });
});

describe('initialMonitorTermState', () => {
  const entry = (id: string, cwd: string) => ({ label: cwd, session: session({ id, cwd }) });

  it('is null without sessions', () => {
    expect(initialMonitorTermState([])).toBeNull();
  });

  it('makes one group per worktree, side by side for up to 3', () => {
    const st = initialMonitorTermState([entry('a1', 'A'), entry('a2', 'a\\'), entry('b1', 'B'), entry('c1', 'C')]);
    expect(st).not.toBeNull();
    const root = st!.groups;
    expect(root.type).toBe('split');
    if (root.type !== 'split') return;
    expect(root.dir).toBe('row');
    expect(root.children.map((c) => (c.type === 'leaf' ? c.sessions : null))).toEqual([['a1', 'a2'], ['b1'], ['c1']]);
    expect(root.sizes.reduce((s, x) => s + x, 0)).toBeCloseTo(100, 6);
    expect(st!.activeGroupId).toBe(root.children[0].id);
  });

  it('collapses to a single group for one worktree', () => {
    const st = initialMonitorTermState([entry('a1', 'A'), entry('a2', 'A')]);
    expect(st!.groups.type).toBe('leaf');
    if (st!.groups.type === 'leaf') expect(st!.groups.activeId).toBe('a1');
  });

  it('lays out more than 3 worktrees as a grid of rows', () => {
    const st = initialMonitorTermState(['A', 'B', 'C', 'D', 'E'].map((w) => entry(w.toLowerCase(), w)));
    const root = st!.groups;
    expect(root.type).toBe('split');
    if (root.type !== 'split') return;
    expect(root.dir).toBe('column');
    expect(root.children).toHaveLength(2); // cols = ceil(sqrt(5)) = 3 → rows: [A,B,C], [D,E]
    expect(allTermGroups(root).map((g) => g.sessions[0])).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('monitorGroupFor', () => {
  it('returns the group holding a session of the same worktree', () => {
    const A = makeTermGroup(['a1'], 'a1');
    const B = makeTermGroup(['b1'], 'b1');
    const root: TermGroupNode = { type: 'split', id: 'S', dir: 'row', sizes: [50, 50], children: [A, B] };
    const live = new Map([
      ['a1', session({ id: 'a1', cwd: 'C:\\A' })],
      ['b1', session({ id: 'b1', cwd: 'C:\\B' })],
      ['b2', session({ id: 'b2', cwd: 'c:/b/' })],
      ['z1', session({ id: 'z1', cwd: 'C:\\Z' })],
    ]);
    expect(monitorGroupFor('b2', root, live)).toBe(B.id);
    expect(monitorGroupFor('z1', root, live)).toBeNull();
    expect(monitorGroupFor('unknown', root, live)).toBeNull();
  });
});
