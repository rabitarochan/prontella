import { describe, expect, it } from 'vitest';
import { parseFollowLog, parseRemotesOutput, unquoteGitPath } from './git.js';

const US = '\x1f';
/** getLog と同じ %H%x1f%h%x1f%P%x1f%an%x1f%cI%x1f%s%x1f%D 形式の 1 コミット分を組み立てる。 */
function prettyLine(fields: {
  hash: string;
  shortHash?: string;
  parents?: string;
  author?: string;
  date?: string;
  subject: string;
  refs?: string;
}): string {
  return [
    fields.hash,
    fields.shortHash ?? fields.hash.slice(0, 7),
    fields.parents ?? '',
    fields.author ?? 'Tester',
    fields.date ?? '2026-01-01T00:00:00+09:00',
    fields.subject,
    fields.refs ?? '',
  ].join(US);
}

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

describe('parseFollowLog', () => {
  // `git log --follow --name-status --pretty=format:<US 区切り> -- <path>` の実出力
  // (隔離環境で 1 回リネームを挟んだフィクスチャに対して実測・突合済み)。
  it('リネームを 1 回挟んだ履歴で、各コミット時点の path/origPath を正しく割り当てる', () => {
    const out = [
      prettyLine({ hash: 'b1c396d0', parents: '335b2da7', subject: 'modify new.txt', refs: 'HEAD -> main' }) +
        '\nM\tnew.txt',
      prettyLine({ hash: '335b2da7', parents: 'e46902f4', subject: 'rename old.txt to new.txt' }) +
        '\nR100\told.txt\tnew.txt',
      prettyLine({ hash: 'e46902f4', parents: '4bd0893b', subject: 'modify old.txt' }) + '\nM\told.txt',
      prettyLine({ hash: '4bd0893b', parents: '', subject: 'add old.txt' }) + '\nA\told.txt',
    ].join('\n\n');

    const entries = parseFollowLog(out);

    expect(entries.map((e) => ({ hash: e.hash, subject: e.subject, path: e.path, origPath: e.origPath }))).toEqual([
      { hash: 'b1c396d0', subject: 'modify new.txt', path: 'new.txt', origPath: null },
      { hash: '335b2da7', subject: 'rename old.txt to new.txt', path: 'new.txt', origPath: 'old.txt' },
      { hash: 'e46902f4', subject: 'modify old.txt', path: 'old.txt', origPath: null },
      { hash: '4bd0893b', subject: 'add old.txt', path: 'old.txt', origPath: null },
    ]);
  });

  it('コピー (C) もリネーム同様 origPath に旧パスを設定する', () => {
    const out = prettyLine({ hash: 'aaa1111', parents: 'bbb2222', subject: 'copy config' }) + '\nC100\tbase.yml\tcopy.yml';
    expect(parseFollowLog(out)).toEqual([
      expect.objectContaining({ hash: 'aaa1111', path: 'copy.yml', origPath: 'base.yml' }),
    ]);
  });

  it('name-status 行が無いコミット (既定 no -m のマージコミット等) は除外する', () => {
    const out = [
      prettyLine({ hash: 'ccc3333', parents: 'ddd4444 eee5555', subject: 'Merge branch x' }), // name-status 行なし
      prettyLine({ hash: 'ddd4444', parents: 'fff6666', subject: 'normal commit' }) + '\nM\tfile.txt',
    ].join('\n\n');
    expect(parseFollowLog(out).map((e) => e.hash)).toEqual(['ddd4444']);
  });

  it('日本語ファイル名を core.quotepath=false 前提でそのまま通す (quote 無しのため unquoteGitPath は恒等)', () => {
    const out = prettyLine({ hash: 'fff7777', parents: '', subject: 'add japanese file' }) + '\nA\t日本語.txt';
    expect(parseFollowLog(out)).toEqual([expect.objectContaining({ path: '日本語.txt', origPath: null })]);
  });

  it('空文字列 (該当パスの履歴なし) は空配列を返す', () => {
    expect(parseFollowLog('')).toEqual([]);
  });
});
