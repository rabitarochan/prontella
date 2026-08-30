import { describe, expect, it } from 'vitest';
import type { SplitDir } from './splitTree';
import {
  activateSession,
  allTermGroups,
  closeSessionInGroup,
  findTermGroup,
  groupOfSession,
  insertSessionInGroup,
  moveSessionToGroup,
  pruneEmptyTermGroups,
  reorderSession,
  sanitizeTermGroups,
  setTermGroupSizes,
  splitWithSession,
  syncSessions,
  type TermGroup,
  type TermGroupNode,
  type TermGroupSplit,
} from './termGroups';

function group(id: string, sessions: string[], activeId: string | null = null): TermGroup {
  return { type: 'leaf', id, sessions, activeId: activeId ?? (sessions[sessions.length - 1] ?? null) };
}

function split(id: string, dir: SplitDir, children: TermGroupNode[]): TermGroupSplit {
  return { type: 'split', id, dir, sizes: children.map(() => 100 / children.length), children };
}

const groupIds = (root: TermGroupNode) => allTermGroups(root).map((g) => g.id);
const sessionsOf = (root: TermGroupNode, id: string) => findTermGroup(root, id)?.sessions ?? null;
const activeOf = (root: TermGroupNode, id: string) => findTermGroup(root, id)?.activeId ?? null;

describe('syncSessions', () => {
  it('どのグループにも無い ID を prefer グループの末尾へ足してアクティブにする', () => {
    const root = split('s', 'row', [group('A', ['t1']), group('B', ['t2'])]);
    const out = syncSessions(root, ['t1', 't2', 't3'], 'A');
    expect(sessionsOf(out, 'A')).toEqual(['t1', 't3']);
    expect(activeOf(out, 'A')).toBe('t3');
    expect(sessionsOf(out, 'B')).toEqual(['t2']);
  });

  it('prefer が存在しなければ先頭グループへ足す', () => {
    const root = split('s', 'row', [group('A', ['t1']), group('B', ['t2'])]);
    const out = syncSessions(root, ['t1', 't2', 't3'], 'GONE');
    expect(sessionsOf(out, 'A')).toEqual(['t1', 't3']);
  });

  it('所有されなくなった ID を全グループから外す', () => {
    const root = split('s', 'row', [group('A', ['t1', 't2'], 't2'), group('B', ['t3'])]);
    const out = syncSessions(root, ['t1', 't3'], null);
    expect(sessionsOf(out, 'A')).toEqual(['t1']);
    // activeId は右隣→左隣ルールで生き残りへ引き継ぐ
    expect(activeOf(out, 'A')).toBe('t1');
    expect(sessionsOf(out, 'B')).toEqual(['t3']);
  });

  it('空になったグループは畳まれる', () => {
    const root = split('s', 'row', [group('A', ['t1']), group('B', ['t2'])]);
    const out = syncSessions(root, ['t2'], null);
    expect(groupIds(out)).toEqual(['B']);
    expect(out.type).toBe('leaf');
  });

  it('全グループが空になっても 1 つは残る', () => {
    const root = split('s', 'row', [group('A', ['t1']), group('B', ['t2'])]);
    const out = syncSessions(root, [], null);
    expect(groupIds(out)).toEqual(['A']);
    expect(sessionsOf(out, 'A')).toEqual([]);
  });

  it('変化が無ければ同一参照を返す (effect からの呼び出しがループしない)', () => {
    const root = split('s', 'row', [group('A', ['t1']), group('B', ['t2'])]);
    expect(syncSessions(root, ['t1', 't2'], 'A')).toBe(root);
  });

  it('順序が違うだけでは変化とみなさない', () => {
    const root = group('A', ['t1', 't2']);
    expect(syncSessions(root, ['t2', 't1'], 'A')).toBe(root);
  });
});

describe('splitWithSession', () => {
  it('複製ではなく移動する (1 セッションは 1 グループにしか属さない)', () => {
    const root = group('A', ['t1', 't2'], 't1');
    const { root: out, newGroupId } = splitWithSession(root, 'A', 'row', false, 't1', 'A');
    expect(newGroupId).not.toBeNull();
    expect(sessionsOf(out, 'A')).toEqual(['t2']);
    expect(sessionsOf(out, newGroupId!)).toEqual(['t1']);
    expect(groupOfSession(out, 't1')?.id).toBe(newGroupId);
  });

  it('タブ 1 枚のグループを自分自身へ分割しても no-op', () => {
    const root = group('A', ['t1']);
    const { root: out, newGroupId } = splitWithSession(root, 'A', 'row', false, 't1', 'A');
    expect(out).toBe(root);
    expect(newGroupId).toBeNull();
  });

  it('別グループへの端ドロップは元グループが空なら畳まれる', () => {
    const root = split('s', 'row', [group('A', ['t1']), group('B', ['t2'])]);
    const { root: out, newGroupId } = splitWithSession(root, 'B', 'column', false, 't1', 'A');
    expect(groupIds(out).sort()).toEqual(['B', newGroupId!].sort());
    expect(sessionsOf(out, newGroupId!)).toEqual(['t1']);
  });

  it('元グループが持っていないセッションは no-op', () => {
    const root = split('s', 'row', [group('A', ['t1']), group('B', ['t2'])]);
    const { root: out, newGroupId } = splitWithSession(root, 'B', 'row', false, 't9', 'A');
    expect(out).toBe(root);
    expect(newGroupId).toBeNull();
  });
});

describe('moveSessionToGroup', () => {
  it('同一グループかつ index 未指定は no-op', () => {
    const root = group('A', ['t1', 't2']);
    expect(moveSessionToGroup(root, 'A', 't1', 'A')).toBe(root);
  });

  it('同一グループ + index は並べ替えに縮退する', () => {
    const root = group('A', ['t1', 't2', 't3']);
    const out = moveSessionToGroup(root, 'A', 't1', 'A', 2);
    expect(sessionsOf(out, 'A')).toEqual(['t2', 't3', 't1']);
  });

  it('別グループへ index 指定で挿入しアクティブにする', () => {
    const root = split('s', 'row', [group('A', ['t1', 't2'], 't1'), group('B', ['t3', 't4'], 't3')]);
    const out = moveSessionToGroup(root, 'A', 't1', 'B', 1);
    expect(sessionsOf(out, 'A')).toEqual(['t2']);
    expect(sessionsOf(out, 'B')).toEqual(['t3', 't1', 't4']);
    expect(activeOf(out, 'B')).toBe('t1');
  });

  it('空になった元グループは畳まれる', () => {
    const root = split('s', 'row', [group('A', ['t1']), group('B', ['t2'])]);
    const out = moveSessionToGroup(root, 'A', 't1', 'B');
    expect(groupIds(out)).toEqual(['B']);
    expect(sessionsOf(out, 'B')).toEqual(['t2', 't1']);
  });
});

describe('closeSessionInGroup', () => {
  it('activeId は右隣、なければ左隣へ引き継ぐ', () => {
    const root = group('A', ['t1', 't2', 't3'], 't2');
    expect(activeOf(closeSessionInGroup(root, 'A', 't2'), 'A')).toBe('t3');
    const last = group('A', ['t1', 't2'], 't2');
    expect(activeOf(closeSessionInGroup(last, 'A', 't2'), 'A')).toBe('t1');
  });

  it('アクティブでないタブを閉じても activeId は動かない', () => {
    const root = group('A', ['t1', 't2'], 't2');
    expect(activeOf(closeSessionInGroup(root, 'A', 't1'), 'A')).toBe('t2');
  });

  it('最後の 1 グループは空でも残る', () => {
    const root = group('A', ['t1']);
    const out = closeSessionInGroup(root, 'A', 't1');
    expect(groupIds(out)).toEqual(['A']);
    expect(activeOf(out, 'A')).toBeNull();
  });
});

describe('insertSessionInGroup / activateSession / reorderSession', () => {
  it('既に持っているセッションの挿入はアクティブ化だけ (重複しない)', () => {
    const root = group('A', ['t1', 't2'], 't2');
    const out = insertSessionInGroup(root, 'A', 't1', 0);
    expect(sessionsOf(out, 'A')).toEqual(['t1', 't2']);
    expect(activeOf(out, 'A')).toBe('t1');
  });

  it('持っていないセッションの activate は no-op', () => {
    const root = group('A', ['t1'], 't1');
    expect(activateSession(root, 'A', 't9')).toBe(root);
  });

  it('reorderSession は範囲外 index をクランプする', () => {
    const root = group('A', ['t1', 't2', 't3']);
    expect(sessionsOf(reorderSession(root, 'A', 't1', 99), 'A')).toEqual(['t2', 't3', 't1']);
    expect(sessionsOf(reorderSession(root, 'A', 't3', -5), 'A')).toEqual(['t3', 't1', 't2']);
  });
});

describe('pruneEmptyTermGroups / setTermGroupSizes', () => {
  it('変化が無ければ同一参照', () => {
    const root = split('s', 'row', [group('A', ['t1']), group('B', ['t2'])]);
    expect(pruneEmptyTermGroups(root)).toBe(root);
  });

  it('sizes を差し替えられる', () => {
    const root = split('s', 'row', [group('A', ['t1']), group('B', ['t2'])]);
    const out = setTermGroupSizes(root, 's', [30, 70]) as TermGroupSplit;
    expect(out.sizes).toEqual([30, 70]);
  });
});

describe('sanitizeTermGroups', () => {
  it('重複したセッション ID は先勝ちで 1 グループだけに残す', () => {
    const out = sanitizeTermGroups({
      type: 'split',
      id: 's',
      dir: 'row',
      sizes: [50, 50],
      children: [
        { type: 'leaf', id: 'A', sessions: ['t1', 't2'], activeId: 't1' },
        { type: 'leaf', id: 'B', sessions: ['t2', 't3'], activeId: 't2' },
      ],
    });
    expect(out).not.toBeNull();
    expect(sessionsOf(out!, 'A')).toEqual(['t1', 't2']);
    expect(sessionsOf(out!, 'B')).toEqual(['t3']);
    // activeId が消えたら生き残りの末尾へ寄せる
    expect(activeOf(out!, 'B')).toBe('t3');
  });

  it('id の重複は再生成する', () => {
    const out = sanitizeTermGroups({
      type: 'split',
      id: 'A',
      dir: 'row',
      sizes: [50, 50],
      children: [
        { type: 'leaf', id: 'A', sessions: ['t1'], activeId: 't1' },
        { type: 'leaf', id: 'A', sessions: ['t2'], activeId: 't2' },
      ],
    });
    expect(out).not.toBeNull();
    expect(new Set(groupIds(out!)).size).toBe(2);
  });

  it('壊れた sizes は等分へ戻す', () => {
    const out = sanitizeTermGroups({
      type: 'split',
      id: 's',
      dir: 'column',
      sizes: ['x', 3],
      children: [
        { type: 'leaf', id: 'A', sessions: ['t1'] },
        { type: 'leaf', id: 'B', sessions: ['t2'] },
      ],
    }) as TermGroupSplit;
    expect(out.sizes).toEqual([50, 50]);
  });

  it('leaf でも split でもない値は null', () => {
    expect(sanitizeTermGroups(null)).toBeNull();
    expect(sanitizeTermGroups({ type: 'nope' })).toBeNull();
    expect(sanitizeTermGroups({ type: 'split', id: 's', dir: 'row', children: [] })).toBeNull();
  });
});
