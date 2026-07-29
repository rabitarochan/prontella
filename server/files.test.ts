import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { MAX_RAW_SIZE, rawMimeFor, resolveRawFile } from './files.js';

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
