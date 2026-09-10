import { describe, expect, it } from 'vitest';
import { ancestorDirs } from './treeReveal';

describe('ancestorDirs', () => {
  it('returns nothing for a root-level file', () => {
    expect(ancestorDirs('a.ts')).toEqual([]);
  });

  it('returns the single parent for a one-level-deep file', () => {
    expect(ancestorDirs('a/b.ts')).toEqual(['a']);
  });

  it('returns every ancestor, shallowest first', () => {
    expect(ancestorDirs('a/b/c/d.ts')).toEqual(['a', 'a/b', 'a/b/c']);
  });

  it('ignores leading, trailing and doubled slashes', () => {
    expect(ancestorDirs('/a/b.ts')).toEqual(['a']);
    expect(ancestorDirs('a/b/')).toEqual(['a']);
    expect(ancestorDirs('a//b/c.ts')).toEqual(['a', 'a/b']);
  });

  it('returns nothing for empty-ish input', () => {
    expect(ancestorDirs('')).toEqual([]);
    expect(ancestorDirs('/')).toEqual([]);
  });
});
