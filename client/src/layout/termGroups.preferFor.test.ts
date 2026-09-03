import { describe, expect, it } from 'vitest';
import { allTermGroups, makeTermGroup, syncSessions, type TermGroupNode } from './termGroups';

function two(): { root: TermGroupNode; a: string; b: string } {
  const A = makeTermGroup(['t1'], 't1');
  const B = makeTermGroup(['t2'], 't2');
  const root: TermGroupNode = { type: 'split', id: 'S', dir: 'row', sizes: [50, 50], children: [A, B] };
  return { root, a: A.id, b: B.id };
}

describe('syncSessions preferFor', () => {
  it('routes each missing id to its own preferred group', () => {
    const { root, a, b } = two();
    const out = syncSessions(root, ['t1', 't2', 't3', 't4'], a, (id) => (id === 't4' ? b : null));
    const groups = allTermGroups(out);
    expect(groups.find((g) => g.id === a)?.sessions).toEqual(['t1', 't3']);
    expect(groups.find((g) => g.id === b)?.sessions).toEqual(['t2', 't4']);
  });

  it('falls back to preferGroupId when preferFor names a missing group', () => {
    const { root, a } = two();
    const out = syncSessions(root, ['t1', 't2', 't9'], a, () => 'nope');
    expect(allTermGroups(out).find((g) => g.id === a)?.sessions).toEqual(['t1', 't9']);
  });

  it('sees the tree as updated by earlier insertions', () => {
    const { root, a, b } = two();
    const seen: number[] = [];
    syncSessions(root, ['t1', 't2', 't3', 't4'], a, (_id, cur) => {
      seen.push(allTermGroups(cur).flatMap((g) => g.sessions).length);
      return b;
    });
    expect(seen).toEqual([2, 3]);
  });
});
