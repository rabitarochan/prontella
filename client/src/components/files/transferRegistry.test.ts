import { describe, expect, it } from 'vitest';
import { MAX_DRAFT_TEXT_LENGTH } from '../../editorState';
import { sanitizeTransferPayload } from './transferRegistry';

describe('sanitizeTransferPayload', () => {
  it('正常な editor payload (draft あり/なし) を通す', () => {
    expect(sanitizeTransferPayload({ kind: 'editor', path: 'a.ts' })).toEqual({
      kind: 'editor',
      path: 'a.ts',
    });
    const withDraft = sanitizeTransferPayload({
      kind: 'editor',
      path: 'a.ts',
      draft: { text: 'unsaved', baseHash: 'h1' },
    });
    expect(withDraft).toEqual({ kind: 'editor', path: 'a.ts', draft: { text: 'unsaved', baseHash: 'h1' } });
  });

  it('preview payload を通すが、draft 付き preview は拒否する', () => {
    expect(sanitizeTransferPayload({ kind: 'preview', path: 'a.md' })).toEqual({
      kind: 'preview',
      path: 'a.md',
    });
    expect(
      sanitizeTransferPayload({ kind: 'preview', path: 'a.md', draft: { text: 'x', baseHash: 'h' } }),
    ).toBeNull();
  });

  it('不正な kind / 空パス / ".." セグメントを拒否する', () => {
    expect(sanitizeTransferPayload({ kind: 'x' as never, path: 'a.ts' })).toBeNull();
    expect(sanitizeTransferPayload({ kind: 'editor', path: '' })).toBeNull();
    expect(sanitizeTransferPayload({ kind: 'editor', path: '../secret.ts' })).toBeNull();
    expect(sanitizeTransferPayload({ kind: 'editor', path: 'dir/../a.ts' })).toBeNull();
  });

  it('draft の形が壊れている・上限超過なら payload ごと拒否する (削って運ばない)', () => {
    expect(
      sanitizeTransferPayload({
        kind: 'editor',
        path: 'a.ts',
        draft: { text: 123 as never, baseHash: 'h' },
      }),
    ).toBeNull();
    expect(
      sanitizeTransferPayload({
        kind: 'editor',
        path: 'a.ts',
        draft: { text: 'x'.repeat(MAX_DRAFT_TEXT_LENGTH + 1), baseHash: 'h' },
      }),
    ).toBeNull();
    // ちょうど上限は通す
    expect(
      sanitizeTransferPayload({
        kind: 'editor',
        path: 'a.ts',
        draft: { text: 'x'.repeat(MAX_DRAFT_TEXT_LENGTH), baseHash: 'h' },
      }),
    ).not.toBeNull();
  });
});
