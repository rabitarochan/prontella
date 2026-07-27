import { describe, expect, it } from 'vitest';
import {
  hashText,
  MAX_DRAFT_TEXT_LENGTH,
  mergeLeafState,
  pruneLeaves,
  sanitizeEditorState,
  type OpenTabRef,
  type WorktreeEditorState,
} from './editorState';

function emptyDoc(): WorktreeEditorState {
  return { version: 1, leaves: {} };
}

function editorRef(path: string): OpenTabRef {
  return { kind: 'editor', path };
}

function previewRef(path: string): OpenTabRef {
  return { kind: 'preview', path };
}

describe('sanitizeEditorState', () => {
  it('rejects a version other than 1', () => {
    expect(sanitizeEditorState({ version: 2, leaves: {} })).toBeNull();
    expect(sanitizeEditorState(null)).toBeNull();
    expect(sanitizeEditorState('nope')).toBeNull();
  });

  it('passes normal data through unchanged', () => {
    const doc: WorktreeEditorState = {
      version: 1,
      leaves: {
        leaf1: {
          openFiles: [editorRef('a.ts'), editorRef('b.ts')],
          activeTab: editorRef('b.ts'),
          viewStates: { 'a.ts': { line: 1 } },
          drafts: { 'a.ts': { text: 'hello', baseHash: 'abc' } },
        },
      },
    };
    expect(sanitizeEditorState(doc)).toEqual(doc);
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
    expect(result?.leaves.leaf1.openFiles).toEqual([
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
    expect(result?.leaves.leaf1.openFiles).toHaveLength(50);
    expect(result?.leaves.leaf1.openFiles).toEqual(openFiles.slice(0, 50).map(editorRef));
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
    expect(result?.leaves.leaf1.activeTab).toEqual(editorRef('b.ts'));
  });

  it('falls back activeTab to null when openFiles is empty', () => {
    const result = sanitizeEditorState({
      version: 1,
      leaves: { leaf1: { openFiles: [], activeTab: { kind: 'editor', path: 'a.ts' }, viewStates: {}, drafts: {} } },
    });
    expect(result?.leaves.leaf1.activeTab).toBeNull();
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
    expect(result?.leaves.leaf1.viewStates).toEqual({ 'a.ts': { line: 1 } });
    expect(result?.leaves.leaf1.drafts).toEqual({ 'a.ts': { text: 'hi', baseHash: 'x' } });
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

  it('drops a leaf slice that is not an object, keeping the rest of the document', () => {
    const result = sanitizeEditorState({
      version: 1,
      leaves: {
        broken: 'not-an-object',
        ok: { openFiles: [editorRef('a.ts')], activeTab: editorRef('a.ts'), viewStates: {}, drafts: {} },
      },
    });
    expect(result?.leaves.broken).toBeUndefined();
    expect(result?.leaves.ok).toEqual({
      openFiles: [editorRef('a.ts')],
      activeTab: editorRef('a.ts'),
      viewStates: {},
      drafts: {},
    });
  });

  describe('backward compatibility with the pre-{kind,path} shape', () => {
    it('normalizes a legacy string[] openFiles into editor tab refs', () => {
      const result = sanitizeEditorState({
        version: 1,
        leaves: {
          leaf1: { openFiles: ['a.ts', 'b.ts'], activeTab: null, viewStates: {}, drafts: {} },
        },
      });
      expect(result?.leaves.leaf1.openFiles).toEqual([editorRef('a.ts'), editorRef('b.ts')]);
    });

    it('reads the legacy activeFile: string field as activeTab when activeTab is absent', () => {
      const result = sanitizeEditorState({
        version: 1,
        leaves: {
          leaf1: { openFiles: ['a.ts', 'b.ts'], activeFile: 'a.ts', viewStates: {}, drafts: {} },
        },
      });
      expect(result?.leaves.leaf1.activeTab).toEqual(editorRef('a.ts'));
    });

    it('keeps drafts attached to a legacy string[] openFiles state (no data loss on upgrade)', () => {
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
      expect(result?.leaves.leaf1.drafts).toEqual({ 'a.ts': { text: 'unsaved work', baseHash: 'h1' } });
      expect(result?.leaves.leaf1.viewStates).toEqual({ 'a.ts': { line: 3 } });
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
      expect(result?.leaves.leaf1.openFiles).toEqual([editorRef('b.ts')]);
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

    it('reads a mix of legacy string entries and new {kind,path} entries in the same openFiles array', () => {
      const result = sanitizeEditorState({
        version: 1,
        leaves: {
          leaf1: {
            openFiles: ['a.ts', { kind: 'preview', path: 'b.md' }],
            activeTab: null,
            viewStates: {},
            drafts: {},
          },
        },
      });
      expect(result?.leaves.leaf1.openFiles).toEqual([editorRef('a.ts'), previewRef('b.md')]);
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
      expect(result?.leaves.leaf1.openFiles).toEqual([editorRef('a.ts'), previewRef('a.ts')]);
    });
  });
});

describe('mergeLeafState', () => {
  it('replaces one leaf slice while keeping other leaves intact', () => {
    const doc: WorktreeEditorState = {
      version: 1,
      leaves: {
        leaf1: { openFiles: [editorRef('a.ts')], activeTab: editorRef('a.ts'), viewStates: {}, drafts: {} },
        leaf2: { openFiles: [editorRef('b.ts')], activeTab: editorRef('b.ts'), viewStates: {}, drafts: {} },
      },
    };
    const next = mergeLeafState(doc, 'leaf1', {
      openFiles: [editorRef('c.ts')],
      activeTab: editorRef('c.ts'),
      viewStates: {},
      drafts: {},
    });
    expect(next.leaves.leaf1.openFiles).toEqual([editorRef('c.ts')]);
    expect(next.leaves.leaf2).toBe(doc.leaves.leaf2);
  });
});

describe('pruneLeaves', () => {
  it('removes leaves not in the live id list', () => {
    const doc: WorktreeEditorState = {
      version: 1,
      leaves: {
        alive: { openFiles: [], activeTab: null, viewStates: {}, drafts: {} },
        dead: { openFiles: [], activeTab: null, viewStates: {}, drafts: {} },
      },
    };
    const next = pruneLeaves(doc, ['alive']);
    expect(Object.keys(next.leaves)).toEqual(['alive']);
  });

  it('returns the same reference when nothing changed', () => {
    const doc: WorktreeEditorState = {
      version: 1,
      leaves: { alive: { openFiles: [], activeTab: null, viewStates: {}, drafts: {} } },
    };
    expect(pruneLeaves(doc, ['alive'])).toBe(doc);

    const empty = emptyDoc();
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
