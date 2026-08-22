import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import {
  copyEntry,
  deleteEntry,
  duplicateName,
  invalidEntryName,
  MAX_RAW_SIZE,
  rawMimeFor,
  renameEntry,
  resolveRawFile,
  resolveRevealTarget,
} from './files.js';

// vitest はリポジトリールートから走るため process.cwd() はリポジトリールートになる。
// ドライブ直下(C:\vt5 等)は後片付けがツール保護に弾かれるため使わず、./vt 配下を使う。
const TMP_ROOT = path.join(process.cwd(), 'vt');

describe('rawMimeFor', () => {
  it.each([
    ['a.png', 'image/png'],
    ['a.jpg', 'image/jpeg'],
    ['a.jpeg', 'image/jpeg'],
    ['a.gif', 'image/gif'],
    ['a.webp', 'image/webp'],
    ['a.bmp', 'image/bmp'],
    ['a.ico', 'image/x-icon'],
    ['a.avif', 'image/avif'],
    ['a.svg', 'image/svg+xml'],
  ])('許可拡張子 %s -> %s', (name, expected) => {
    expect(rawMimeFor(name)).toBe(expected);
  });

  it('大文字拡張子も受ける', () => {
    expect(rawMimeFor('a.PNG')).toBe('image/png');
    expect(rawMimeFor('A.JPG')).toBe('image/jpeg');
  });

  it.each(['a.ts', 'a.md', 'a.exe'])('非許可拡張子 %s は null', (name) => {
    expect(rawMimeFor(name)).toBeNull();
  });

  it('拡張子無しは null', () => {
    expect(rawMimeFor('README')).toBeNull();
  });

  it('ドットで終わる名前は null', () => {
    expect(rawMimeFor('a.')).toBeNull();
  });

  it('多重拡張子は最後の拡張子だけを見る(.tar.gz は非許可)', () => {
    expect(rawMimeFor('archive.tar.gz')).toBeNull();
  });

  it('空文字列は null', () => {
    expect(rawMimeFor('')).toBeNull();
  });
});

describe('resolveRawFile', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function makeTmpDir(): string {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    tmpDir = fs.mkdtempSync(path.join(TMP_ROOT, 'files-raw-it-'));
    return tmpDir;
  }

  it('実在する画像ファイルを ok:true で解決する', () => {
    const dir = makeTmpDir();
    const abs = path.join(dir, 'a.png');
    fs.writeFileSync(abs, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG マジックバイト風のダミー内容
    const result = resolveRawFile(dir, 'a.png');
    expect(result).toEqual({ ok: true, abs, mime: 'image/png', size: 4 });
  });

  it('サブディレクトリー配下の画像も解決する', () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, 'img'));
    const abs = path.join(dir, 'img', 'b.svg');
    fs.writeFileSync(abs, '<svg></svg>');
    const result = resolveRawFile(dir, 'img/b.svg');
    expect(result).toEqual({ ok: true, abs, mime: 'image/svg+xml', size: 11 });
  });

  it('root 外を指すパスは 400', () => {
    const dir = makeTmpDir();
    const result = resolveRawFile(dir, '../../../etc/hosts');
    expect(result).toEqual({ ok: false, status: 400, error: expect.any(String) });
  });

  it('画像以外の拡張子は 415(root 外ではなく単に対応拡張子でない場合)', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'README.md'), '# hello');
    const result = resolveRawFile(dir, 'README.md');
    expect(result).toEqual({ ok: false, status: 415, error: expect.any(String) });
  });

  it('存在しないパスは 404', () => {
    const dir = makeTmpDir();
    const result = resolveRawFile(dir, 'missing.png');
    expect(result).toEqual({ ok: false, status: 404, error: expect.any(String) });
  });

  it('ディレクトリーを指すと 404(通常ファイルでない)', () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, 'sub.png')); // わざと画像拡張子のディレクトリー名にする
    const result = resolveRawFile(dir, 'sub.png');
    expect(result).toEqual({ ok: false, status: 404, error: expect.any(String) });
  });

  it('MAX_RAW_SIZE を超えるファイルは 413', () => {
    const dir = makeTmpDir();
    const abs = path.join(dir, 'big.png');
    fs.writeFileSync(abs, Buffer.alloc(MAX_RAW_SIZE + 1));
    const result = resolveRawFile(dir, 'big.png');
    expect(result).toEqual({ ok: false, status: 413, error: expect.any(String) });
  });

  it('root 外を指す非画像拡張子は 415 でなく 400(root 外判定が最優先)', () => {
    const dir = makeTmpDir();
    const result = resolveRawFile(dir, '../../../Windows/win.ini');
    expect(result).toEqual({ ok: false, status: 400, error: expect.any(String) });
  });
});

describe('invalidEntryName', () => {
  it.each(['a.ts', 'foo copy.md', '.env', '日本語.txt'])('妥当な名前 %s は null', (name) => {
    expect(invalidEntryName(name)).toBeNull();
  });

  it.each([
    ['', '空文字'],
    ['   ', '空白のみ'],
    [null, 'null'],
    [42, '非文字列'],
    [['a', 'b'], '配列 (JSON body の細工)'],
    ['a/b', 'スラッシュ'],
    ['a\\b', 'バックスラッシュ'],
    ['..', '親ディレクトリー参照'],
    ['.', 'カレント参照'],
  ])('不正な名前 (%j: %s) はエラーメッセージ', (name) => {
    expect(invalidEntryName(name)).toEqual(expect.any(String));
  });
});

describe('renameEntry', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function makeTmpDir(): string {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    tmpDir = fs.mkdtempSync(path.join(TMP_ROOT, 'files-rename-it-'));
    return tmpDir;
  }

  it('ファイルを同一ディレクトリー内でリネームし新相対パスを返す', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'a.ts'), 'content');
    expect(renameEntry(dir, 'a.ts', 'b.ts')).toBe('b.ts');
    expect(fs.existsSync(path.join(dir, 'a.ts'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'b.ts'), 'utf8')).toBe('content');
  });

  it('サブディレクトリー配下のリネームは親パスを維持する (forward slash)', () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'a.ts'), 'x');
    expect(renameEntry(dir, 'sub/a.ts', 'b.ts')).toBe('sub/b.ts');
    expect(fs.existsSync(path.join(dir, 'sub', 'b.ts'))).toBe(true);
  });

  it('ディレクトリーもリネームできる', () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, 'old'));
    fs.writeFileSync(path.join(dir, 'old', 'f.txt'), 'x');
    expect(renameEntry(dir, 'old', 'new')).toBe('new');
    expect(fs.readFileSync(path.join(dir, 'new', 'f.txt'), 'utf8')).toBe('x');
  });

  it.each(['a/b', 'a\\b', '..', '.', '', '  '])('不正な newName %j は拒否する', (newName) => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'a.ts'), 'x');
    expect(() => renameEntry(dir, 'a.ts', newName)).toThrow();
    expect(fs.existsSync(path.join(dir, 'a.ts'))).toBe(true);
  });

  it('既存パスへのリネームは拒否する (上書きしない)', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'a.ts'), 'A');
    fs.writeFileSync(path.join(dir, 'b.ts'), 'B');
    expect(() => renameEntry(dir, 'a.ts', 'b.ts')).toThrow(/既に存在/);
    expect(fs.readFileSync(path.join(dir, 'b.ts'), 'utf8')).toBe('B');
  });

  it('存在しない対象は拒否する', () => {
    const dir = makeTmpDir();
    expect(() => renameEntry(dir, 'missing.ts', 'b.ts')).toThrow();
  });

  it('名前が同一なら何もせず同じ相対パスを返す', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'a.ts'), 'x');
    expect(renameEntry(dir, 'a.ts', 'a.ts')).toBe('a.ts');
    expect(fs.existsSync(path.join(dir, 'a.ts'))).toBe(true);
  });

  // Windows では existsSync('foo.ts') が 'Foo.ts' にもヒットするため、case-only リネームが
  // 衝突扱いされないことを固定する (win32 以外では通常のリネームとして成立する)。
  it('case-only リネーム (Foo.ts → foo.ts) を許可する', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'Foo.ts'), 'x');
    expect(renameEntry(dir, 'Foo.ts', 'foo.ts')).toBe('foo.ts');
    expect(fs.readdirSync(dir)).toEqual(['foo.ts']);
  });
});

describe('duplicateName', () => {
  it('初回は " copy" を拡張子の前に挟む', () => {
    expect(duplicateName('foo.ts', () => false)).toBe('foo copy.ts');
  });

  it('衝突したら連番を進める (copy 2, copy 3, ...)', () => {
    const taken = new Set(['foo copy.ts', 'foo copy 2.ts']);
    expect(duplicateName('foo.ts', (c) => taken.has(c))).toBe('foo copy 3.ts');
  });

  it('拡張子なしの名前は末尾に付ける', () => {
    expect(duplicateName('Makefile', () => false)).toBe('Makefile copy');
  });

  it('ドットファイル (.env) は拡張子なし扱い', () => {
    expect(duplicateName('.env', () => false)).toBe('.env copy');
  });

  it('多重拡張子は最後の拡張子だけ分離する', () => {
    expect(duplicateName('a.test.ts', () => false)).toBe('a.test copy.ts');
  });
});

describe('copyEntry', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function makeTmpDir(): string {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    tmpDir = fs.mkdtempSync(path.join(TMP_ROOT, 'files-copy-it-'));
    return tmpDir;
  }

  it('ファイルを "name copy.ext" として複製し新相対パスを返す', async () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'a.ts'), 'content');
    await expect(copyEntry(dir, 'a.ts')).resolves.toBe('a copy.ts');
    expect(fs.readFileSync(path.join(dir, 'a copy.ts'), 'utf8')).toBe('content');
    expect(fs.readFileSync(path.join(dir, 'a.ts'), 'utf8')).toBe('content'); // 元は残る
  });

  it('連続実行で copy 2 が生まれる', async () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'a.ts'), 'x');
    await copyEntry(dir, 'a.ts');
    await expect(copyEntry(dir, 'a.ts')).resolves.toBe('a copy 2.ts');
  });

  it('サブディレクトリー配下は親パスを維持する', async () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'a.ts'), 'x');
    await expect(copyEntry(dir, 'sub/a.ts')).resolves.toBe('sub/a copy.ts');
  });

  it('ディレクトリーは再帰コピーする', async () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, 'd', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'd', 'nested', 'f.txt'), 'deep');
    await expect(copyEntry(dir, 'd')).resolves.toBe('d copy');
    expect(fs.readFileSync(path.join(dir, 'd copy', 'nested', 'f.txt'), 'utf8')).toBe('deep');
  });

  it('root 外を指すパスは拒否する', async () => {
    const dir = makeTmpDir();
    await expect(copyEntry(dir, '../outside.ts')).rejects.toThrow();
  });
});

describe('deleteEntry', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function makeTmpDir(): string {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    tmpDir = fs.mkdtempSync(path.join(TMP_ROOT, 'files-delete-it-'));
    return tmpDir;
  }

  it('ファイルを削除する', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'a.ts'), 'x');
    deleteEntry(dir, 'a.ts');
    expect(fs.existsSync(path.join(dir, 'a.ts'))).toBe(false);
  });

  it('ディレクトリーは中身ごと再帰削除する', () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, 'd', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'd', 'nested', 'f.txt'), 'x');
    deleteEntry(dir, 'd');
    expect(fs.existsSync(path.join(dir, 'd'))).toBe(false);
  });

  it('存在しない対象は ENOENT で失敗する', () => {
    const dir = makeTmpDir();
    expect(() => deleteEntry(dir, 'missing.ts')).toThrow();
  });

  it('root 外を指すパスは拒否する', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'a.ts'), 'x');
    expect(() => deleteEntry(dir, '../../outside')).toThrow(/ルート外/);
  });

  it.each(['', '.', './'])('root 自体に解決されるパス %j は拒否する', (rel) => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'a.ts'), 'x');
    expect(() => deleteEntry(dir, rel)).toThrow(/ルート自体/);
    expect(fs.existsSync(path.join(dir, 'a.ts'))).toBe(true);
  });
});

describe('resolveRevealTarget', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function makeTmpDir(): string {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    tmpDir = fs.mkdtempSync(path.join(TMP_ROOT, 'files-reveal-it-'));
    return tmpDir;
  }

  it('実在するファイルを ok:true で解決する', () => {
    const dir = makeTmpDir();
    const abs = path.join(dir, 'a.ts');
    fs.writeFileSync(abs, 'x');
    expect(resolveRevealTarget(dir, 'a.ts')).toEqual({ ok: true, abs });
  });

  it('ディレクトリーも ok:true で解決する', () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, 'sub'));
    expect(resolveRevealTarget(dir, 'sub')).toEqual({ ok: true, abs: path.join(dir, 'sub') });
  });

  it('root 外は 400', () => {
    const dir = makeTmpDir();
    expect(resolveRevealTarget(dir, '../../etc')).toEqual({
      ok: false,
      status: 400,
      error: expect.any(String),
    });
  });

  it('存在しないパスは 404', () => {
    const dir = makeTmpDir();
    expect(resolveRevealTarget(dir, 'missing.ts')).toEqual({
      ok: false,
      status: 404,
      error: expect.any(String),
    });
  });
});
