import { describe, expect, it } from 'vitest';
import {
  hashText,
  MAX_DRAFT_TEXT_LENGTH,
  mergeLeafState,
  pruneLeaves,
  sanitizeEditorState,
  type WorktreeEditorState,
} from './editorState';

function emptyDoc(): WorktreeEditorState {
  return { version: 1, leaves: {} };
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
          openFiles: ['a.ts', 'b.ts'],
          activeFile: 'b.ts',
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
          openFiles: ['a.ts', '', 'b.ts', 'a.ts', '../secret.ts', 'dir/../c.ts', 'c.ts'],
          activeFile: null,
          viewStates: {},
          drafts: {},
        },
      },
    });
    expect(result?.leaves.leaf1.openFiles).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('truncates openFiles to 50 entries', () => {
    const openFiles = Array.from({ length: 60 }, (_, i) => `file${i}.ts`);
    const result = sanitizeEditorState({
      version: 1,
      leaves: { leaf1: { openFiles, activeFile: null, viewStates: {}, drafts: {} } },
    });
    expect(result?.leaves.leaf1.openFiles).toHaveLength(50);
    expect(result?.leaves.leaf1.openFiles).toEqual(openFiles.slice(0, 50));
  });

  it('falls back activeFile to the last open file when it is not among openFiles', () => {
    const result = sanitizeEditorState({
      version: 1,
      leaves: {
        leaf1: { openFiles: ['a.ts', 'b.ts'], activeFile: 'not-open.ts', viewStates: {}, drafts: {} },
      },
    });
    expect(result?.leaves.leaf1.activeFile).toBe('b.ts');
  });

  it('falls back activeFile to null when openFiles is empty', () => {
    const result = sanitizeEditorState({
      version: 1,
      leaves: { leaf1: { openFiles: [], activeFile: 'a.ts', viewStates: {}, drafts: {} } },
    });
    expect(result?.leaves.leaf1.activeFile).toBeNull();
  });

  it('drops viewStates and drafts entries for paths not in openFiles (orphans)', () => {
    const result = sanitizeEditorState({
      version: 1,
      leaves: {
        leaf1: {
          openFiles: ['a.ts'],
          activeFile: 'a.ts',
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
          openFiles: ['a.ts', 'b.ts', 'c.ts'],
          activeFile: null,
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
          openFiles: ['a.ts'],
          activeFile: null,
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
        ok: { openFiles: ['a.ts'], activeFile: 'a.ts', viewStates: {}, drafts: {} },
      },
    });
    expect(result?.leaves.broken).toBeUndefined();
    expect(result?.leaves.ok).toEqual({
      openFiles: ['a.ts'],
      activeFile: 'a.ts',
      viewStates: {},
      drafts: {},
    });
  });
});

describe('mergeLeafState', () => {
  it('replaces one leaf slice while keeping other leaves intact', () => {
    const doc: WorktreeEditorState = {
      version: 1,
      leaves: {
        leaf1: { openFiles: ['a.ts'], activeFile: 'a.ts', viewStates: {}, drafts: {} },
        leaf2: { openFiles: ['b.ts'], activeFile: 'b.ts', viewStates: {}, drafts: {} },
      },
    };
    const next = mergeLeafState(doc, 'leaf1', {
      openFiles: ['c.ts'],
      activeFile: 'c.ts',
      viewStates: {},
      drafts: {},
    });
    expect(next.leaves.leaf1.openFiles).toEqual(['c.ts']);
    expect(next.leaves.leaf2).toBe(doc.leaves.leaf2);
  });
});

describe('pruneLeaves', () => {
  it('removes leaves not in the live id list', () => {
    const doc: WorktreeEditorState = {
      version: 1,
      leaves: {
        alive: { openFiles: [], activeFile: null, viewStates: {}, drafts: {} },
        dead: { openFiles: [], activeFile: null, viewStates: {}, drafts: {} },
      },
    };
    const next = pruneLeaves(doc, ['alive']);
    expect(Object.keys(next.leaves)).toEqual(['alive']);
  });

  it('returns the same reference when nothing changed', () => {
    const doc: WorktreeEditorState = {
      version: 1,
      leaves: { alive: { openFiles: [], activeFile: null, viewStates: {}, drafts: {} } },
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
