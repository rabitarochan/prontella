import { describe, expect, it } from 'vitest';
import { hashText } from '../../editorState';
import type { FileContent } from '../../types';
import { decideDiskSync, diskHash, shouldCheckDisk, type DiskSyncEntry } from './diskSync';

/** テキストファイルのディスク内容。 */
function disk(content: string): FileContent {
  return {
    path: 'a.ts',
    content,
    binary: false,
    tooLarge: false,
    size: content.length,
    encoding: 'utf-8',
    hasBom: false,
    editorconfig: null,
  };
}

/** binary / tooLarge のディスク内容 (content === null)。 */
function diskNull(kind: 'binary' | 'tooLarge', size = 999): FileContent {
  return {
    path: 'a.ts',
    content: null,
    binary: kind === 'binary',
    tooLarge: kind === 'tooLarge',
    size,
    encoding: null,
    hasBom: false,
    editorconfig: null,
  };
}

/** 開いたときの内容が `opened`、現在の draft が `draft` のエディタータブ。 */
function entry(opened: string, draft = opened): DiskSyncEntry {
  return { kind: 'editor', file: disk(opened), draft };
}

describe('shouldCheckDisk', () => {
  it('通常のエディタータブだけ true', () => {
    expect(shouldCheckDisk(entry('x'))).toBe(true);
  });

  it('preview / 未ロード / binary / tooLarge は false (fetch も出さない)', () => {
    expect(shouldCheckDisk({ kind: 'preview', file: disk('x'), draft: '' })).toBe(false);
    expect(shouldCheckDisk({ kind: 'editor', file: null, draft: '' })).toBe(false);
    expect(shouldCheckDisk({ kind: 'editor', file: diskNull('binary'), draft: '' })).toBe(false);
    expect(shouldCheckDisk({ kind: 'editor', file: diskNull('tooLarge'), draft: '' })).toBe(false);
    expect(shouldCheckDisk(null)).toBe(false);
    expect(shouldCheckDisk(undefined)).toBe(false);
  });

  it('shouldCheckDisk が false のものは decideDiskSync でも必ず skip (両者の条件は同じ)', () => {
    const cases: DiskSyncEntry[] = [
      { kind: 'preview', file: disk('x'), draft: '' },
      { kind: 'editor', file: null, draft: '' },
      { kind: 'editor', file: diskNull('binary'), draft: '' },
      { kind: 'editor', file: diskNull('tooLarge'), draft: '' },
    ];
    for (const e of cases) {
      expect(shouldCheckDisk(e)).toBe(false);
      expect(decideDiskSync(e, disk('新しい内容'))).toEqual({ kind: 'skip' });
    }
  });
});

describe('decideDiskSync — 仕様の 4 ケース', () => {
  it('変化なし × 未編集 → unchanged', () => {
    expect(decideDiskSync(entry('old'), disk('old'))).toEqual({ kind: 'unchanged' });
  });

  it('変化なし × 編集中 → unchanged (編集は継続)', () => {
    expect(decideDiskSync(entry('old', 'my edit'), disk('old'))).toEqual({ kind: 'unchanged' });
  });

  it('変化あり × 未編集 → apply', () => {
    expect(decideDiskSync(entry('old'), disk('new'))).toEqual({ kind: 'apply' });
  });

  it('変化あり × 編集中 → conflict', () => {
    expect(decideDiskSync(entry('old', 'my edit'), disk('new'))).toEqual({ kind: 'conflict' });
  });
});

describe('decideDiskSync — 分岐の網羅', () => {
  it('編集内容がディスクと一致 → conflict ではなく apply (適用すれば dirty が解消する)', () => {
    expect(decideDiskSync(entry('old', 'new'), disk('new'))).toEqual({ kind: 'apply' });
  });

  it('見送り済みハッシュと一致 → suppressed (同じ内容では二度と聞かない)', () => {
    const d = disk('new');
    expect(decideDiskSync(entry('old', 'my edit'), d, diskHash(d))).toEqual({ kind: 'suppressed' });
  });

  it('見送り後にディスクがさらに別内容へ変わった → suppressed ではなく conflict', () => {
    const seen = disk('new');
    const newer = disk('newer');
    expect(decideDiskSync(entry('old', 'my edit'), newer, diskHash(seen))).toEqual({
      kind: 'conflict',
    });
  });

  it('見送り済みでも未編集なら apply が優先される (聞く相手がいない)', () => {
    const d = disk('new');
    expect(decideDiskSync(entry('old'), d, diskHash(d))).toEqual({ kind: 'apply' });
  });

  it('ignoredHash が未指定なら suppressed にはならない', () => {
    expect(decideDiskSync(entry('old', 'my edit'), disk('new'), undefined)).toEqual({
      kind: 'conflict',
    });
  });
});

describe('decideDiskSync — ディスク側が binary / tooLarge 化', () => {
  it('未編集 → apply (プレースホルダー表示に切り替わる)', () => {
    expect(decideDiskSync(entry('old'), diskNull('binary'))).toEqual({ kind: 'apply' });
    expect(decideDiskSync(entry('old'), diskNull('tooLarge'))).toEqual({ kind: 'apply' });
  });

  it('編集中 → conflict', () => {
    expect(decideDiskSync(entry('old', 'my edit'), diskNull('binary'))).toEqual({
      kind: 'conflict',
    });
  });

  it('編集中 + 見送り済み → suppressed', () => {
    const d = diskNull('tooLarge');
    expect(decideDiskSync(entry('old', 'my edit'), d, diskHash(d))).toEqual({ kind: 'suppressed' });
  });

  it('draft が空文字でも disk.content === null とは一致させない', () => {
    // '' === null にならないことの明示 (null 混同の回帰ガード)
    expect(decideDiskSync(entry('old', ''), diskNull('binary'))).toEqual({ kind: 'conflict' });
  });
});

describe('decideDiskSync — 空文字列と null の取り違えガード', () => {
  it('開いたとき空 → 内容が入った: 未編集なら apply', () => {
    expect(decideDiskSync(entry(''), disk('hello'))).toEqual({ kind: 'apply' });
  });

  it('開いたとき空 → ディスクも空: unchanged (skip ではない)', () => {
    expect(decideDiskSync(entry(''), disk(''))).toEqual({ kind: 'unchanged' });
    expect(shouldCheckDisk(entry(''))).toBe(true);
  });

  it('内容あり → ディスクが空になった: 未編集なら apply、編集中なら conflict', () => {
    expect(decideDiskSync(entry('old'), disk(''))).toEqual({ kind: 'apply' });
    expect(decideDiskSync(entry('old', 'my edit'), disk(''))).toEqual({ kind: 'conflict' });
  });
});

describe('diskHash', () => {
  it('テキストは内容のハッシュ、内容が同じなら一致する', () => {
    expect(diskHash(disk('abc'))).toBe(hashText('abc'));
    expect(diskHash(disk('abc'))).toBe(diskHash(disk('abc')));
    expect(diskHash(disk('abc'))).not.toBe(diskHash(disk('abd')));
  });

  it('content === null はサイズと種別で代用し、テキストのハッシュと衝突しない', () => {
    expect(diskHash(diskNull('binary', 10))).toBe('nil:10:b');
    expect(diskHash(diskNull('tooLarge', 10))).toBe('nil:10:t');
    expect(diskHash(diskNull('binary', 10))).not.toBe(diskHash(diskNull('tooLarge', 10)));
    expect(diskHash(diskNull('binary', 10))).not.toBe(diskHash(disk('')));
  });
});
