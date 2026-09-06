import { describe, expect, it } from 'vitest';
import { vscodeFolderParam } from './folderParam';

describe('vscodeFolderParam', () => {
  it('Windows パスを先頭スラッシュ + 小文字ドライブに変換する', () => {
    expect(vscodeFolderParam('C:\\Users\\x\\proj')).toBe('/c%3A/Users/x/proj');
  });

  it('ドライブレターを小文字化する (uri.ts の fsPath 導出に合わせる)', () => {
    expect(vscodeFolderParam('D:\\repo')).toBe('/d%3A/repo');
    expect(vscodeFolderParam('d:\\repo')).toBe('/d%3A/repo');
  });

  it('スラッシュ区切りの Windows パスも受ける', () => {
    expect(vscodeFolderParam('C:/Users/x/proj')).toBe('/c%3A/Users/x/proj');
  });

  it('ドライブ直下を扱える', () => {
    expect(vscodeFolderParam('C:\\')).toBe('/c%3A/');
    expect(vscodeFolderParam('C:')).toBe('/c%3A/');
  });

  it('POSIX の絶対パスはそのまま (先頭スラッシュを重ねない)', () => {
    expect(vscodeFolderParam('/home/x/proj')).toBe('/home/x/proj');
  });

  it('区切りの / は残し、セグメントだけ符号化する', () => {
    expect(vscodeFolderParam('C:\\a b\\c#d')).toBe('/c%3A/a%20b/c%23d');
  });

  it('日本語などの非 ASCII を符号化する', () => {
    expect(vscodeFolderParam('C:\\プロジェクト')).toBe(
      `/c%3A/${encodeURIComponent('プロジェクト')}`,
    );
  });

  it('クエリを壊す文字を残さない', () => {
    // & や = が生で出ると ?folder= の値が途中で切れる
    const out = vscodeFolderParam('C:\\a&b=c\\d');
    expect(out).not.toMatch(/[&=]/);
  });
});
