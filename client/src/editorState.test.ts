import { describe, expect, it } from 'vitest';
import type { EditorGroup, GroupNode, GroupSplit } from './components/files/editorGroups';
import {
  hashText,
  MAX_DRAFT_TEXT_LENGTH,
  mergeLeafState,
  pruneLeaves,
  sanitizeEditorState,
  type LeafEditorState,
  type OpenTabRef,
  type WorktreeEditorState,
} from './editorState';

function editorRef(path: string): OpenTabRef {
  return { kind: 'editor', path };
}

function previewRef(path: string): OpenTabRef {
  return { kind: 'preview', path };
}

/** v2 の leaf は常に最低 1 グループ。単一グループ前提のテストで root を group として読む。 */
function asGroup(node: GroupNode | undefined): EditorGroup {
  if (!node || node.type !== 'leaf') throw new Error('expected a single group root');
  return node;
}

function groupsOf(node: GroupNode): EditorGroup[] {
  if (node.type === 'leaf') return [node];
  return node.children.flatMap(groupsOf);
}

function emptyLeafState(): LeafEditorState {
  return {
    groups: { type: 'leaf', id: 'g1', tabs: [], activeKey: null },
    activeGroupId: 'g1',
    viewStates: {},
    drafts: {},
  };
}

describe('sanitizeEditorState', () => {
  it('rejects unknown versions and non-objects', () => {
    expect(sanitizeEditorState({ version: 3, leaves: {} })).toBeNull();
    expect(sanitizeEditorState(null)).toBeNull();
    expect(sanitizeEditorState('nope')).toBeNull();
  });

  it('always returns a version 2 document (v1 input migrates on read)', () => {
    expect(sanitizeEditorState({ version: 1, leaves: {} })?.version).toBe(2);
    expect(sanitizeEditorState({ version: 2, leaves: {} })?.version).toBe(2);
  });

  describe('v1 → v2 migration', () => {
    it('wraps openFiles/activeTab into a single group and re-keys viewStates by that group', () => {
      const result = sanitizeEditorState({
        version: 1,
        leaves: {
          leaf1: {
            openFiles: [editorRef('a.ts'), editorRef('b.ts')],
            activeTab: editorRef('b.ts'),
            viewStates: { 'a.ts': { line: 1 } },
            drafts: { 'a.ts': { text: 'hello', baseHash: 'abc' } },
          },
        },
      });
      const leaf = result?.leaves.leaf1;
      const g = asGroup(leaf?.groups);
      expect(g.tabs).toEqual([editorRef('a.ts'), editorRef('b.ts')]);
      expect(g.activeKey).toBe('editor:b.ts');
      expect(leaf?.activeGroupId).toBe(g.id);
      expect(leaf?.viewStates).toEqual({ [g.id]: { 'a.ts': { line: 1 } } });
      expect(leaf?.drafts).toEqual({ 'a.ts': { text: 'hello', baseHash: 'abc' } });
    });

    it('removes duplicate, empty, and ".." path segments from openFiles, preserving tab order', () => {
      const result = sanitizeEditorState({
        version: 1,
        leaves: {
          leaf1: {
            openFiles: [
              'a.ts',
              '',
              'b.ts',
              'a.ts',
              '../secret.ts',
              'dir/../c.ts',
              'c.ts',
              { kind: 'preview', path: '' },
              { kind: 'preview', path: '../secret.md' },
            ],
            activeTab: null,
            viewStates: {},
            drafts: {},
          },
        },
      });
      expect(asGroup(result?.leaves.leaf1.groups).tabs).toEqual([
        editorRef('a.ts'),
        editorRef('b.ts'),
        editorRef('c.ts'),
      ]);
    });

    it('truncates openFiles to 50 entries (counting both kinds together)', () => {
      const openFiles = Array.from({ length: 60 }, (_, i) => `file${i}.ts`);
      const result = sanitizeEditorState({
        version: 1,
        leaves: { leaf1: { openFiles, activeTab: null, viewStates: {}, drafts: {} } },
      });
      const tabs = asGroup(result?.leaves.leaf1.groups).tabs;
      expect(tabs).toHaveLength(50);
      expect(tabs).toEqual(openFiles.slice(0, 50).map(editorRef));
    });

    it('falls back activeTab to the last open tab when it is not among openFiles', () => {
      const result = sanitizeEditorState({
        version: 1,
        leaves: {
          leaf1: {
            openFiles: ['a.ts', 'b.ts'],
            activeTab: { kind: 'editor', path: 'not-open.ts' },
            viewStates: {},
            drafts: {},
          },
        },
      });
      expect(asGroup(result?.leaves.leaf1.groups).activeKey).toBe('editor:b.ts');
    });

    it('falls back activeKey to null when openFiles is empty', () => {
      const result = sanitizeEditorState({
        version: 1,
        leaves: { leaf1: { openFiles: [], activeTab: { kind: 'editor', path: 'a.ts' }, viewStates: {}, drafts: {} } },
      });
      expect(asGroup(result?.leaves.leaf1.groups).activeKey).toBeNull();
    });

    it('drops viewStates and drafts entries for paths not in openFiles (orphans)', () => {
      const result = sanitizeEditorState({
        version: 1,
        leaves: {
          leaf1: {
            openFiles: [editorRef('a.ts')],
            activeTab: editorRef('a.ts'),
            viewStates: { 'a.ts': { line: 1 }, 'orphan.ts': { line: 2 } },
            drafts: {
              'a.ts': { text: 'hi', baseHash: 'x' },
              'orphan.ts': { text: 'bye', baseHash: 'y' },
            },
          },
        },
      });
      const leaf = result?.leaves.leaf1;
      const gid = asGroup(leaf?.groups).id;
      expect(leaf?.viewStates).toEqual({ [gid]: { 'a.ts': { line: 1 } } });
      expect(leaf?.drafts).toEqual({ 'a.ts': { text: 'hi', baseHash: 'x' } });
    });

    it('drops drafts with the wrong shape or oversized text', () => {
      const result = sanitizeEditorState({
        version: 1,
        leaves: {
          leaf1: {
            openFiles: [editorRef('a.ts'), editorRef('b.ts'), editorRef('c.ts')],
            activeTab: null,
            viewStates: {},
            drafts: {
              'a.ts': { text: 'ok', baseHash: 'x' },
              'b.ts': { text: 123, baseHash: 'x' },
              'c.ts': { text: 'x'.repeat(MAX_DRAFT_TEXT_LENGTH + 1), baseHash: 'x' },
            },
          },
        },
      });
      expect(result?.leaves.leaf1.drafts).toEqual({ 'a.ts': { text: 'ok', baseHash: 'x' } });
    });

    it('keeps a draft exactly at MAX_DRAFT_TEXT_LENGTH (only strictly-over is dropped)', () => {
      const text = 'x'.repeat(MAX_DRAFT_TEXT_LENGTH);
      const result = sanitizeEditorState({
        version: 1,
        leaves: {
          leaf1: {
            openFiles: [editorRef('a.ts')],
            activeTab: null,
            viewStates: {},
            drafts: { 'a.ts': { text, baseHash: 'x' } },
          },
        },
      });
      expect(result?.leaves.leaf1.drafts).toEqual({ 'a.ts': { text, baseHash: 'x' } });
    });

    it('reads the legacy activeFile: string field and legacy string[] openFiles', () => {
      const result = sanitizeEditorState({
        version: 1,
        leaves: {
          leaf1: {
            openFiles: ['a.ts', 'b.ts'],
            activeFile: 'a.ts',
            viewStates: { 'a.ts': { line: 3 } },
            drafts: { 'a.ts': { text: 'unsaved work', baseHash: 'h1' } },
          },
        },
      });
      const leaf = result?.leaves.leaf1;
      const g = asGroup(leaf?.groups);
      expect(g.tabs).toEqual([editorRef('a.ts'), editorRef('b.ts')]);
      expect(g.activeKey).toBe('editor:a.ts');
      expect(leaf?.drafts).toEqual({ 'a.ts': { text: 'unsaved work', baseHash: 'h1' } });
      expect(leaf?.viewStates).toEqual({ [g.id]: { 'a.ts': { line: 3 } } });
    });

    it('drops an open-tab entry with an invalid kind', () => {
      const result = sanitizeEditorState({
        version: 1,
        leaves: {
          leaf1: {
            openFiles: [{ kind: 'x', path: 'a.ts' }, editorRef('b.ts')],
            activeTab: null,
            viewStates: {},
            drafts: {},
          },
        },
      });
      expect(asGroup(result?.leaves.leaf1.groups).tabs).toEqual([editorRef('b.ts')]);
    });

    it('drops viewStates/drafts for a path that is only open as a preview tab', () => {
      const result = sanitizeEditorState({
        version: 1,
        leaves: {
          leaf1: {
            openFiles: [previewRef('a.md')],
            activeTab: previewRef('a.md'),
            viewStates: { 'a.md': { line: 1 } },
            drafts: { 'a.md': { text: 'should not survive', baseHash: 'x' } },
          },
        },
      });
      expect(result?.leaves.leaf1.viewStates).toEqual({});
      expect(result?.leaves.leaf1.drafts).toEqual({});
    });

    it('keeps both an editor tab and a preview tab for the same path (not deduped against each other)', () => {
      const result = sanitizeEditorState({
        version: 1,
        leaves: {
          leaf1: {
            openFiles: [editorRef('a.ts'), previewRef('a.ts')],
            activeTab: null,
            viewStates: {},
            drafts: {},
          },
        },
      });
      expect(asGroup(result?.leaves.leaf1.groups).tabs).toEqual([editorRef('a.ts'), previewRef('a.ts')]);
    });
  });

  describe('v2 leaves', () => {
    it('passes a normal grouped leaf through unchanged', () => {
      const doc: WorktreeEditorState = {
        version: 2,
        leaves: {
          leaf1: {
            groups: {
              type: 'split',
              id: 's1',
              dir: 'row',
              sizes: [50, 50],
              children: [
                { type: 'leaf', id: 'g1', tabs: [editorRef('a.ts')], activeKey: 'editor:a.ts' },
                { type: 'leaf', id: 'g2', tabs: [editorRef('b.ts')], activeKey: 'editor:b.ts' },
              ],
            },
            activeGroupId: 'g2',
            viewStates: { g1: { 'a.ts': { line: 1 } } },
            drafts: { 'a.ts': { text: 'hello', baseHash: 'abc' } },
          },
        },
      };
      expect(sanitizeEditorState(doc)).toEqual(doc);
    });

    it('allows the same key in two groups but never twice within one group', () => {
      const result = sanitizeEditorState({
        version: 2,
        leaves: {
          leaf1: {
            groups: {
              type: 'split',
              id: 's1',
              dir: 'row',
              sizes: [50, 50],
              children: [
                {
                  type: 'leaf',
                  id: 'g1',
                  tabs: [editorRef('a.ts'), editorRef('a.ts'), editorRef('b.ts')],
                  activeKey: 'editor:a.ts',
                },
                { type: 'leaf', id: 'g2', tabs: [editorRef('a.ts')], activeKey: 'editor:a.ts' },
              ],
            },
            activeGroupId: 'g1',
            viewStates: {},
            drafts: {},
          },
        },
      });
      const groups = groupsOf(result!.leaves.leaf1.groups);
      expect(groups[0].tabs).toEqual([editorRef('a.ts'), editorRef('b.ts')]);
      expect(groups[1].tabs).toEqual([editorRef('a.ts')]);
    });

    it('caps DISTINCT keys at 50 across groups (a shared key does not count twice)', () => {
      const many = Array.from({ length: 49 }, (_, i) => editorRef(`f${i}.ts`));
      const result = sanitizeEditorState({
        version: 2,
        leaves: {
          leaf1: {
            groups: {
              type: 'split',
              id: 's1',
              dir: 'row',
              sizes: [50, 50],
              children: [
                { type: 'leaf', id: 'g1', tabs: many, activeKey: null },
                {
                  type: 'leaf',
                  id: 'g2',
                  // f0 は既出 (無料)、new1 は 50 個目 (入る)、new2 は 51 個目 (落ちる)
                  tabs: [editorRef('f0.ts'), editorRef('new1.ts'), editorRef('new2.ts')],
                  activeKey: null,
                },
              ],
            },
            activeGroupId: 'g1',
            viewStates: {},
            drafts: {},
          },
        },
      });
      const groups = groupsOf(result!.leaves.leaf1.groups);
      expect(groups[0].tabs).toHaveLength(49);
      expect(groups[1].tabs).toEqual([editorRef('f0.ts'), editorRef('new1.ts')]);
    });

    it('fixes an activeKey not present in the group to the last tab', () => {
      const result = sanitizeEditorState({
        version: 2,
        leaves: {
          leaf1: {
            groups: { type: 'leaf', id: 'g1', tabs: [editorRef('a.ts'), editorRef('b.ts')], activeKey: 'editor:zzz.ts' },
            activeGroupId: 'g1',
            viewStates: {},
            drafts: {},
          },
        },
      });
      expect(asGroup(result?.leaves.leaf1.groups).activeKey).toBe('editor:b.ts');
    });

    it('drops empty groups on restore (collapsing the split), keeping one when all are empty', () => {
      const result = sanitizeEditorState({
        version: 2,
        leaves: {
          leaf1: {
            groups: {
              type: 'split',
              id: 's1',
              dir: 'row',
              sizes: [50, 50],
              children: [
                { type: 'leaf', id: 'g1', tabs: [], activeKey: null },
                { type: 'leaf', id: 'g2', tabs: [editorRef('a.ts')], activeKey: 'editor:a.ts' },
              ],
            },
            activeGroupId: 'g1',
            viewStates: {},
            drafts: {},
          },
        },
      });
      const g = asGroup(result?.leaves.leaf1.groups);
      expect(g.id).toBe('g2');
      // activeGroupId は消えたグループを指していたので生存グループへフォールバック
      expect(result?.leaves.leaf1.activeGroupId).toBe('g2');

      const allEmpty = sanitizeEditorState({
        version: 2,
        leaves: {
          leaf1: {
            groups: {
              type: 'split',
              id: 's1',
              dir: 'row',
              sizes: [50, 50],
              children: [
                { type: 'leaf', id: 'g1', tabs: [], activeKey: null },
                { type: 'leaf', id: 'g2', tabs: [], activeKey: null },
              ],
            },
            activeGroupId: 'g1',
            viewStates: {},
            drafts: {},
          },
        },
      });
      expect(groupsOf(allEmpty!.leaves.leaf1.groups)).toHaveLength(1);
    });

    it('renormalizes invalid split sizes and de-duplicates node ids', () => {
      const result = sanitizeEditorState({
        version: 2,
        leaves: {
          leaf1: {
            groups: {
              type: 'split',
              id: 'dup',
              dir: 'row',
              sizes: [1, 2, 3], // 長さ不一致 → equalSizes
              children: [
                { type: 'leaf', id: 'dup', tabs: [editorRef('a.ts')], activeKey: null },
                { type: 'leaf', id: 'dup', tabs: [editorRef('b.ts')], activeKey: null },
              ],
            },
            activeGroupId: 'nope',
            viewStates: {},
            drafts: {},
          },
        },
      });
      const root = result!.leaves.leaf1.groups as GroupSplit;
      expect(root.sizes).toEqual([50, 50]);
      const ids = groupsOf(root).map((g) => g.id);
      expect(new Set([root.id, ...ids]).size).toBe(3);
      // activeGroupId は不在 id → 先頭グループへ
      expect(result?.leaves.leaf1.activeGroupId).toBe(ids[0]);
    });

    it('drops viewStates for unknown groups / paths not open as editor in THAT group', () => {
      const result = sanitizeEditorState({
        version: 2,
        leaves: {
          leaf1: {
            groups: {
              type: 'split',
              id: 's1',
              dir: 'row',
              sizes: [50, 50],
              children: [
                { type: 'leaf', id: 'g1', tabs: [editorRef('a.ts')], activeKey: 'editor:a.ts' },
                { type: 'leaf', id: 'g2', tabs: [editorRef('b.ts')], activeKey: 'editor:b.ts' },
              ],
            },
            activeGroupId: 'g1',
            viewStates: {
              g1: { 'a.ts': { line: 1 }, 'b.ts': { line: 2 } }, // b.ts は g1 に無い → 落ちる
              gone: { 'a.ts': { line: 3 } }, // 不在グループ → 落ちる
            },
            drafts: {
              'a.ts': { text: 'ok', baseHash: 'x' },
              'zzz.ts': { text: 'orphan', baseHash: 'x' }, // どのグループにも無い → 落ちる
            },
          },
        },
      });
      expect(result?.leaves.leaf1.viewStates).toEqual({ g1: { 'a.ts': { line: 1 } } });
      expect(result?.leaves.leaf1.drafts).toEqual({ 'a.ts': { text: 'ok', baseHash: 'x' } });
    });

    it('drops a leaf slice that is not an object, keeping the rest of the document', () => {
      const result = sanitizeEditorState({
        version: 2,
        leaves: {
          broken: 'not-an-object',
          ok: {
            groups: { type: 'leaf', id: 'g1', tabs: [editorRef('a.ts')], activeKey: 'editor:a.ts' },
            activeGroupId: 'g1',
            viewStates: {},
            drafts: {},
          },
        },
      });
      expect(result?.leaves.broken).toBeUndefined();
      expect(asGroup(result?.leaves.ok.groups).tabs).toEqual([editorRef('a.ts')]);
    });
  });
});

describe('mergeLeafState', () => {
  it('replaces one leaf slice while keeping other leaves intact', () => {
    const doc: WorktreeEditorState = {
      version: 2,
      leaves: { leaf1: emptyLeafState(), leaf2: emptyLeafState() },
    };
    const replacement: LeafEditorState = {
      groups: { type: 'leaf', id: 'gX', tabs: [editorRef('c.ts')], activeKey: 'editor:c.ts' },
      activeGroupId: 'gX',
      viewStates: {},
      drafts: {},
    };
    const next = mergeLeafState(doc, 'leaf1', replacement);
    expect(next.leaves.leaf1).toBe(replacement);
    expect(next.leaves.leaf2).toBe(doc.leaves.leaf2);
  });
});

describe('pruneLeaves', () => {
  it('removes leaves not in the live id list', () => {
    const doc: WorktreeEditorState = {
      version: 2,
      leaves: { alive: emptyLeafState(), dead: emptyLeafState() },
    };
    const next = pruneLeaves(doc, ['alive']);
    expect(Object.keys(next.leaves)).toEqual(['alive']);
  });

  it('returns the same reference when nothing changed', () => {
    const doc: WorktreeEditorState = { version: 2, leaves: { alive: emptyLeafState() } };
    expect(pruneLeaves(doc, ['alive'])).toBe(doc);

    const empty: WorktreeEditorState = { version: 2, leaves: {} };
    expect(pruneLeaves(empty, [])).toBe(empty);
  });
});

describe('hashText', () => {
  it('is deterministic for the same input', () => {
    expect(hashText('hello world')).toBe(hashText('hello world'));
  });

  it('differs for different inputs', () => {
    expect(hashText('hello')).not.toBe(hashText('world'));
    expect(hashText('')).not.toBe(hashText('a'));
  });
});
