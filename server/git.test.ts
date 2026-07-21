import { describe, expect, it } from 'vitest';
import { parseRemotesOutput, unquoteGitPath } from './git.js';

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

describe('parseRemotesOutput', () => {
  it('通常の remote (fetch/push が同一 URL) を 1 件にまとめる', () => {
    const out = ['origin\thttps://example.com/repo.git (fetch)', 'origin\thttps://example.com/repo.git (push)'].join(
      '\n',
    );
    expect(parseRemotesOutput(out)).toEqual([
      { name: 'origin', fetchUrl: 'https://example.com/repo.git', pushUrl: 'https://example.com/repo.git' },
    ]);
  });

  it('空白を含む Windows パス URL を取りこぼさない (旧 \\S+ 実装の回帰防止)', () => {
    const out = [
      'backup\tC:\\Users\\dev\\My Documents\\repo (fetch)',
      'backup\tC:\\Users\\dev\\My Documents\\repo (push)',
    ].join('\n');
    expect(parseRemotesOutput(out)).toEqual([
      { name: 'backup', fetchUrl: 'C:\\Users\\dev\\My Documents\\repo', pushUrl: 'C:\\Users\\dev\\My Documents\\repo' },
    ]);
  });

  it('fetch と push で異なる URL を別フィールドに割り当てる', () => {
    const out = [
      'origin\thttps://example.com/fetch-repo.git (fetch)',
      'origin\thttps://example.com/push-repo.git (push)',
    ].join('\n');
    expect(parseRemotesOutput(out)).toEqual([
      { name: 'origin', fetchUrl: 'https://example.com/fetch-repo.git', pushUrl: 'https://example.com/push-repo.git' },
    ]);
  });

  it('空行や remote 行以外の余計な行を無視する', () => {
    const out = [
      '',
      'origin\thttps://example.com/repo.git (fetch)',
      'not a remote line',
      'origin\thttps://example.com/repo.git (push)',
      '',
    ].join('\n');
    expect(parseRemotesOutput(out)).toEqual([
      { name: 'origin', fetchUrl: 'https://example.com/repo.git', pushUrl: 'https://example.com/repo.git' },
    ]);
  });

  it('複数 remote を name ごとに分けて返す', () => {
    const out = [
      'origin\thttps://example.com/repo.git (fetch)',
      'origin\thttps://example.com/repo.git (push)',
      'backup\thttps://backup.example.com/repo.git (fetch)',
      'backup\thttps://backup.example.com/repo.git (push)',
    ].join('\n');
    expect(parseRemotesOutput(out)).toEqual([
      { name: 'origin', fetchUrl: 'https://example.com/repo.git', pushUrl: 'https://example.com/repo.git' },
      { name: 'backup', fetchUrl: 'https://backup.example.com/repo.git', pushUrl: 'https://backup.example.com/repo.git' },
    ]);
  });
});
