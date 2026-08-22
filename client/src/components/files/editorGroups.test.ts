import { describe, expect, it } from 'vitest';
import type { OpenTabRef } from '../../editorState';
import type { SplitDir } from '../../layout/splitTree';
import {
  activateTab,
  allGroups,
  closeTabInGroup,
  distinctKeys,
  findGroup,
  groupsWithKey,
  insertTabInGroup,
  moveTabToGroup,
  openTabInGroup,
  orphanedKeysAfter,
  pathIsWithin,
  pickEviction,
  pruneEmptyGroups,
  removeTabPaths,
  renamedPath,
  renameTabPaths,
  reorderTab,
  splitWithTab,
  type EditorGroup,
  type GroupNode,
  type GroupSplit,
} from './editorGroups';

function ref(path: string, kind: OpenTabRef['kind'] = 'editor'): OpenTabRef {
  return { kind, path };
}

function group(id: string, paths: string[], activePath?: string): EditorGroup {
  return {
    type: 'leaf',
    id,
    tabs: paths.map((p) => ref(p)),
    activeKey: activePath !== undefined ? `editor:${activePath}` : (paths.length ? `editor:${paths[paths.length - 1]}` : null),
  };
}

function split(id: string, dir: SplitDir, children: GroupNode[]): GroupSplit {
  return { type: 'split', id, dir, sizes: children.map(() => 100 / children.length), children };
}

const groupIds = (root: GroupNode) => allGroups(root).map((g) => g.id);
const tabsOf = (root: GroupNode, id: string) => findGroup(root, id)!.tabs.map((t) => t.path);

describe('openTabInGroup', () => {
  it('未オープンならグループ末尾に追加してアクティブ化する', () => {
    const root = group('A', ['a.ts']);
    const out = openTabInGroup(root, 'A', ref('b.ts'));
    expect(tabsOf(out, 'A')).toEqual(['a.ts', 'b.ts']);
    expect(findGroup(out, 'A')!.activeKey).toBe('editor:b.ts');
  });

  it('同グループで既に開いていればアクティブ化のみ (重複追加しない)', () => {
    const root = group('A', ['a.ts', 'b.ts'], 'b.ts');
    const out = openTabInGroup(root, 'A', ref('a.ts'));
    expect(tabsOf(out, 'A')).toEqual(['a.ts', 'b.ts']);
    expect(findGroup(out, 'A')!.activeKey).toBe('editor:a.ts');
  });

  it('別グループに同キーがあってもアクティブグループに追加する (VS Code 同様)', () => {
    const root = split('s', 'row', [group('A', ['a.ts']), group('B', ['b.ts'])]);
    const out = openTabInGroup(root, 'B', ref('a.ts'));
    expect(tabsOf(out, 'B')).toEqual(['b.ts', 'a.ts']);
    expect(groupsWithKey(out, 'editor:a.ts')).toEqual(['A', 'B']);
  });

  it('editor と preview は同一パスでも別タブ', () => {
    const root = group('A', ['a.md']);
    const out = openTabInGroup(root, 'A', ref('a.md', 'preview'));
    expect(findGroup(out, 'A')!.tabs).toHaveLength(2);
    expect(distinctKeys(out)).toEqual(['editor:a.md', 'preview:a.md']);
  });
});

describe('closeTabInGroup', () => {
  it('右隣、なければ左隣がアクティブになる', () => {
    const root = group('A', ['a.ts', 'b.ts', 'c.ts'], 'b.ts');
    const out = closeTabInGroup(root, 'A', 'editor:b.ts');
    expect(tabsOf(out, 'A')).toEqual(['a.ts', 'c.ts']);
    expect(findGroup(out, 'A')!.activeKey).toBe('editor:c.ts');

    const out2 = closeTabInGroup(out, 'A', 'editor:c.ts');
    expect(findGroup(out2, 'A')!.activeKey).toBe('editor:a.ts');
  });

  it('非アクティブタブを閉じても activeKey は変わらない', () => {
    const root = group('A', ['a.ts', 'b.ts'], 'a.ts');
    const out = closeTabInGroup(root, 'A', 'editor:b.ts');
    expect(findGroup(out, 'A')!.activeKey).toBe('editor:a.ts');
  });

  it('最後のタブを閉じたグループは畳まれ、隣のグループが残る', () => {
    const root = split('s', 'row', [group('A', ['a.ts']), group('B', ['b.ts'])]);
    const out = closeTabInGroup(root, 'A', 'editor:a.ts');
    expect(groupIds(out)).toEqual(['B']);
    expect(out.type).toBe('leaf'); // 単子 split は collapse される
  });

  it('パネル最後のグループは空になっても残る', () => {
    const root = group('A', ['a.ts']);
    const out = closeTabInGroup(root, 'A', 'editor:a.ts');
    expect(groupIds(out)).toEqual(['A']);
    expect(findGroup(out, 'A')!.tabs).toEqual([]);
    expect(findGroup(out, 'A')!.activeKey).toBeNull();
  });
});

describe('reorderTab', () => {
  it('挿入 index はドラッグタブ除去後の並びに対するもの', () => {
    const root = group('A', ['a.ts', 'b.ts', 'c.ts']);
    // a を末尾へ
    expect(tabsOf(reorderTab(root, 'A', 'editor:a.ts', 2), 'A')).toEqual(['b.ts', 'c.ts', 'a.ts']);
    // c を先頭へ
    expect(tabsOf(reorderTab(root, 'A', 'editor:c.ts', 0), 'A')).toEqual(['c.ts', 'a.ts', 'b.ts']);
  });

  it('index は範囲にクランプされる / 不在キーは no-op', () => {
    const root = group('A', ['a.ts', 'b.ts']);
    expect(tabsOf(reorderTab(root, 'A', 'editor:a.ts', 99), 'A')).toEqual(['b.ts', 'a.ts']);
    expect(tabsOf(reorderTab(root, 'A', 'editor:zzz', 0), 'A')).toEqual(['a.ts', 'b.ts']);
  });
});

describe('insertTabInGroup', () => {
  it('指定 index に挿入してアクティブ化する (省略時は末尾)', () => {
    const root = group('A', ['a.ts', 'b.ts'], 'a.ts');
    const out = insertTabInGroup(root, 'A', ref('c.ts'), 1);
    expect(tabsOf(out, 'A')).toEqual(['a.ts', 'c.ts', 'b.ts']);
    expect(findGroup(out, 'A')!.activeKey).toBe('editor:c.ts');
    expect(tabsOf(insertTabInGroup(root, 'A', ref('c.ts')), 'A')).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('既に同キーを保持しているグループではアクティブ化のみ', () => {
    const root = group('A', ['a.ts', 'b.ts'], 'b.ts');
    const out = insertTabInGroup(root, 'A', ref('a.ts'), 0);
    expect(tabsOf(out, 'A')).toEqual(['a.ts', 'b.ts']);
    expect(findGroup(out, 'A')!.activeKey).toBe('editor:a.ts');
  });
});

describe('moveTabToGroup', () => {
  it('別グループへ移動し、移動先でアクティブになる', () => {
    const root = split('s', 'row', [group('A', ['a.ts', 'b.ts']), group('B', ['c.ts'])]);
    const out = moveTabToGroup(root, 'A', 'editor:a.ts', 'B', 0);
    expect(tabsOf(out, 'A')).toEqual(['b.ts']);
    expect(tabsOf(out, 'B')).toEqual(['a.ts', 'c.ts']);
    expect(findGroup(out, 'B')!.activeKey).toBe('editor:a.ts');
  });

  it('移動元が空になったらグループごと畳む', () => {
    const root = split('s', 'row', [group('A', ['a.ts']), group('B', ['b.ts'])]);
    const out = moveTabToGroup(root, 'A', 'editor:a.ts', 'B');
    expect(groupIds(out)).toEqual(['B']);
    expect(tabsOf(out, 'B')).toEqual(['b.ts', 'a.ts']);
  });

  it('移動先に同キーが既にあればアクティブ化に縮退 (グループ内重複を作らない)', () => {
    const root = split('s', 'row', [group('A', ['a.ts', 'b.ts']), group('B', ['a.ts'], 'a.ts')]);
    const out = moveTabToGroup(root, 'A', 'editor:a.ts', 'B');
    expect(tabsOf(out, 'A')).toEqual(['b.ts']);
    expect(tabsOf(out, 'B')).toEqual(['a.ts']);
    expect(findGroup(out, 'B')!.activeKey).toBe('editor:a.ts');
  });

  it('src === dst は index 指定時のみ並べ替え', () => {
    const root = group('A', ['a.ts', 'b.ts']);
    expect(moveTabToGroup(root, 'A', 'editor:a.ts', 'A')).toBe(root);
    expect(tabsOf(moveTabToGroup(root, 'A', 'editor:a.ts', 'A', 1), 'A')).toEqual(['b.ts', 'a.ts']);
  });
});

describe('splitWithTab', () => {
  it('source あり = 移動: 元グループから消え、新グループが隣にできる', () => {
    const root = group('A', ['a.ts', 'b.ts']);
    const { root: out, newGroupId } = splitWithTab(root, 'A', 'row', false, ref('b.ts'), {
      groupId: 'A',
    });
    expect(newGroupId).not.toBeNull();
    expect(tabsOf(out, 'A')).toEqual(['a.ts']);
    expect(tabsOf(out, newGroupId!)).toEqual(['b.ts']);
    const s = out as GroupSplit;
    expect(s.type).toBe('split');
    expect(s.dir).toBe('row');
    expect(groupIds(out)).toEqual(['A', newGroupId]);
  });

  it('source なし = 複製 (分割ボタン): 同キーが両グループに残る', () => {
    const root = group('A', ['a.ts']);
    const { root: out, newGroupId } = splitWithTab(root, 'A', 'row', false, ref('a.ts'));
    expect(tabsOf(out, 'A')).toEqual(['a.ts']);
    expect(tabsOf(out, newGroupId!)).toEqual(['a.ts']);
    expect(groupsWithKey(out, 'editor:a.ts')).toEqual(['A', newGroupId]);
  });

  it('before=true は対象の前に挿入する', () => {
    const root = group('A', ['a.ts', 'b.ts']);
    const { root: out, newGroupId } = splitWithTab(root, 'A', 'column', true, ref('b.ts'), {
      groupId: 'A',
    });
    expect(groupIds(out)).toEqual([newGroupId, 'A']);
  });

  it('単独タブの自グループ分割 (移動) は元グループが畳まれ新グループだけ残る', () => {
    const root = split('s', 'row', [group('A', ['a.ts']), group('B', ['b.ts'])]);
    const { root: out, newGroupId } = splitWithTab(root, 'A', 'column', false, ref('a.ts'), {
      groupId: 'A',
    });
    expect(groupIds(out).sort()).toEqual([newGroupId!, 'B'].sort());
    expect(tabsOf(out, newGroupId!)).toEqual(['a.ts']);
  });

  it('不在の dst は no-op (newGroupId: null)', () => {
    const root = group('A', ['a.ts']);
    const { root: out, newGroupId } = splitWithTab(root, 'Z', 'row', false, ref('a.ts'));
    expect(out).toBe(root);
    expect(newGroupId).toBeNull();
  });
});

describe('pruneEmptyGroups', () => {
  it('空グループを除去しサイズを再正規化する', () => {
    const root = split('s', 'row', [group('A', []), group('B', ['b.ts']), group('C', ['c.ts'])]);
    const out = pruneEmptyGroups(root);
    expect(groupIds(out)).toEqual(['B', 'C']);
    const s = out as GroupSplit;
    expect(s.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(100);
  });

  it('全グループが空なら先頭の 1 つだけ残す', () => {
    const root = split('s', 'row', [group('A', []), group('B', [])]);
    const out = pruneEmptyGroups(root);
    expect(groupIds(out)).toEqual(['A']);
  });
});

describe('参照カウント導出 (groupsWithKey / distinctKeys / orphanedKeysAfter)', () => {
  const root = split('s', 'row', [group('A', ['a.ts', 'shared.ts']), group('B', ['shared.ts'])]);

  it('groupsWithKey は保持グループを木順で返す', () => {
    expect(groupsWithKey(root, 'editor:shared.ts')).toEqual(['A', 'B']);
    expect(groupsWithKey(root, 'editor:a.ts')).toEqual(['A']);
  });

  it('共有キーのタブを片方で閉じてもキーは orphan にならない', () => {
    const after = closeTabInGroup(root, 'A', 'editor:shared.ts');
    expect(orphanedKeysAfter(root, after)).toEqual([]);
    expect(groupsWithKey(after, 'editor:shared.ts')).toEqual(['B']);
  });

  it('最後の参照を閉じたキーだけが orphan になる', () => {
    const after = closeTabInGroup(root, 'A', 'editor:a.ts');
    expect(orphanedKeysAfter(root, after)).toEqual(['editor:a.ts']);
  });
});

describe('pickEviction', () => {
  const root = split('s', 'row', [
    group('A', ['a.ts', 'shared.ts', 'b.ts']),
    group('B', ['shared.ts', 'c.ts']),
  ]);

  it('除外キー・共有キー・非 evictable をスキップして木順の先頭を返す', () => {
    const picked = pickEviction(root, {
      excludeKeys: ['editor:a.ts'],
      isEvictable: (k) => k !== 'editor:b.ts',
    });
    // a.ts=除外, shared.ts=2 グループ共有, b.ts=evictable でない → c.ts
    expect(picked).toEqual({ groupId: 'B', key: 'editor:c.ts' });
  });

  it('候補が無ければ null', () => {
    expect(pickEviction(root, { excludeKeys: [], isEvictable: () => false })).toBeNull();
  });
});

describe('activateTab', () => {
  it('保持しているキーのみアクティブ化する', () => {
    const root = group('A', ['a.ts', 'b.ts'], 'b.ts');
    expect(findGroup(activateTab(root, 'A', 'editor:a.ts'), 'A')!.activeKey).toBe('editor:a.ts');
    expect(activateTab(root, 'A', 'editor:zzz')).toBe(root);
  });
});

describe('renamedPath', () => {
  it('完全一致は新パスを返す', () => {
    expect(renamedPath('src/a.ts', 'src/a.ts', 'src/b.ts')).toBe('src/b.ts');
  });

  it('ディレクトリー配下 (from + "/") はプレフィックス置換する', () => {
    expect(renamedPath('src/deep/a.ts', 'src', 'lib')).toBe('lib/deep/a.ts');
  });

  it('無関係なパスは null', () => {
    expect(renamedPath('other/a.ts', 'src', 'lib')).toBeNull();
  });

  it('名前が前方一致するだけの別ディレクトリー (src2) は対象外', () => {
    expect(renamedPath('src2/a.ts', 'src', 'lib')).toBeNull();
  });
});

describe('renameTabPaths', () => {
  it('ファイルリネームで ref と activeKey が追随する (editor / preview 両方)', () => {
    const root: EditorGroup = {
      type: 'leaf',
      id: 'A',
      tabs: [ref('a.md'), ref('a.md', 'preview'), ref('other.ts')],
      activeKey: 'preview:a.md',
    };
    const out = renameTabPaths(root, 'a.md', 'b.md');
    const g = findGroup(out, 'A')!;
    expect(g.tabs).toEqual([ref('b.md'), ref('b.md', 'preview'), ref('other.ts')]);
    expect(g.activeKey).toBe('preview:b.md');
  });

  it('ディレクトリーリネームは配下の全タブをプレフィックス置換する', () => {
    const root = group('A', ['src/a.ts', 'src/deep/b.ts', 'lib/c.ts'], 'src/deep/b.ts');
    const out = renameTabPaths(root, 'src', 'renamed');
    expect(tabsOf(out, 'A')).toEqual(['renamed/a.ts', 'renamed/deep/b.ts', 'lib/c.ts']);
    expect(findGroup(out, 'A')!.activeKey).toBe('editor:renamed/deep/b.ts');
  });

  it('複数グループに同じファイルが開いていても両方追随する', () => {
    const root = split('s', 'row', [group('A', ['a.ts'], 'a.ts'), group('B', ['a.ts', 'b.ts'], 'b.ts')]);
    const out = renameTabPaths(root, 'a.ts', 'c.ts');
    expect(tabsOf(out, 'A')).toEqual(['c.ts']);
    expect(findGroup(out, 'A')!.activeKey).toBe('editor:c.ts');
    expect(tabsOf(out, 'B')).toEqual(['c.ts', 'b.ts']);
    expect(findGroup(out, 'B')!.activeKey).toBe('editor:b.ts'); // 無関係な activeKey は不変
  });

  it('書き換えでグループ内のキーが重複したら先勝ちで dedupe する', () => {
    const root = group('A', ['a.ts', 'b.ts'], 'b.ts');
    const out = renameTabPaths(root, 'b.ts', 'a.ts');
    expect(tabsOf(out, 'A')).toEqual(['a.ts']);
    // activeKey は書き換え後のキーを指したまま (dedupe で生き残った同一キー)
    expect(findGroup(out, 'A')!.activeKey).toBe('editor:a.ts');
  });

  it('無関係なリネームではタブ構成が変わらない', () => {
    const root = group('A', ['a.ts'], 'a.ts');
    const out = renameTabPaths(root, 'x.ts', 'y.ts');
    expect(allGroups(out)).toEqual(allGroups(root));
  });
});

describe('pathIsWithin', () => {
  it('自身と "/" 区切りの配下だけが true (前方一致するだけの別パスは false)', () => {
    expect(pathIsWithin('src', 'src')).toBe(true);
    expect(pathIsWithin('src/deep/a.ts', 'src')).toBe(true);
    expect(pathIsWithin('src2/a.ts', 'src')).toBe(false);
    expect(pathIsWithin('other', 'src')).toBe(false);
  });
});

describe('removeTabPaths', () => {
  it('ファイル削除で editor / preview 両方のタブが消える', () => {
    const root: EditorGroup = {
      type: 'leaf',
      id: 'A',
      tabs: [ref('a.md'), ref('a.md', 'preview'), ref('b.ts')],
      activeKey: 'editor:b.ts',
    };
    const out = removeTabPaths(root, 'a.md');
    expect(findGroup(out, 'A')!.tabs).toEqual([ref('b.ts')]);
    expect(findGroup(out, 'A')!.activeKey).toBe('editor:b.ts');
  });

  it('ディレクトリー削除は配下の全タブを消す', () => {
    const root = group('A', ['src/a.ts', 'src/deep/b.ts', 'lib/c.ts'], 'lib/c.ts');
    const out = removeTabPaths(root, 'src');
    expect(tabsOf(out, 'A')).toEqual(['lib/c.ts']);
  });

  it('アクティブタブが消えたら右隣、なければ左隣へ引き継ぐ', () => {
    const right = removeTabPaths(group('A', ['a.ts', 'b.ts', 'c.ts'], 'b.ts'), 'b.ts');
    expect(findGroup(right, 'A')!.activeKey).toBe('editor:c.ts');
    const left = removeTabPaths(group('A', ['a.ts', 'b.ts'], 'b.ts'), 'b.ts');
    expect(findGroup(left, 'A')!.activeKey).toBe('editor:a.ts');
  });

  it('空になったグループは畳まれ、隣が残る', () => {
    const root = split('s', 'row', [group('A', ['src/a.ts'], 'src/a.ts'), group('B', ['b.ts'], 'b.ts')]);
    const out = removeTabPaths(root, 'src');
    expect(groupIds(out)).toEqual(['B']);
    expect(out.type).toBe('leaf');
  });

  it('パネル最後のグループは空になっても残り、activeKey は null になる', () => {
    const out = removeTabPaths(group('A', ['a.ts'], 'a.ts'), 'a.ts');
    expect(groupIds(out)).toHaveLength(1);
    expect(allGroups(out)[0].tabs).toEqual([]);
    expect(allGroups(out)[0].activeKey).toBeNull();
  });

  it('無関係な削除ではタブ構成が変わらない', () => {
    const root = group('A', ['a.ts'], 'a.ts');
    expect(allGroups(removeTabPaths(root, 'x.ts'))).toEqual(allGroups(root));
  });
});
