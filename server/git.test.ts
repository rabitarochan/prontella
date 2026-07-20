import { describe, expect, it } from 'vitest';
import { unquoteGitPath } from './git.js';

describe('unquoteGitPath', () => {
  it('passes through a path that git did not quote', () => {
    expect(unquoteGitPath('src/index.ts')).toBe('src/index.ts');
  });

  it('decodes octal-escaped UTF-8 bytes into the original multibyte text', () => {
    expect(unquoteGitPath('"\\346\\227\\245\\346\\234\\254\\350\\252\\236.txt"')).toBe('日本語.txt');
  });

  it('decodes escaped double quotes and backslashes', () => {
    expect(unquoteGitPath('"foo\\"bar\\\\baz"')).toBe('foo"bar\\baz');
  });
});
