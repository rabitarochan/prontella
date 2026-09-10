import { describe, expect, it } from 'vitest';
import iconv from 'iconv-lite';
import { decodeDiffPair } from './diffEncoding.js';
import { MAX_FILE_SIZE } from './files.js';

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);

function sjis(text: string): Buffer {
  return iconv.encode(text, 'shift_jis');
}

describe('decodeDiffPair', () => {
  it('decodes plain UTF-8 on both sides', () => {
    const r = decodeDiffPair(Buffer.from('a\nb\n'), Buffer.from('a\nc\n'), 'modified');
    expect(r).toMatchObject({
      original: 'a\nb\n',
      modified: 'a\nc\n',
      encoding: 'utf-8',
      hasBom: false,
      binary: false,
      tooLarge: false,
    });
  });

  // 本命: 検出側 (modified) が Shift_JIS なら original も Shift_JIS として読む。
  // 片側だけ自動判定していた旧実装ではここが化けて全行差分になっていた。
  it('decodes both sides with the encoding detected from the modified side', () => {
    const original = sjis('日本語のテキスト\n共通行\n');
    const modified = sjis('日本語のテキスト(変更後)\n共通行\n');
    const r = decodeDiffPair(original, modified, 'modified');
    expect(r.encoding).toBe('shift_jis');
    expect(r.original).toBe('日本語のテキスト\n共通行\n');
    expect(r.modified).toBe('日本語のテキスト(変更後)\n共通行\n');
    expect(r.binary).toBe(false);
  });

  it('detects from the original side when asked', () => {
    // jschardet は短い非 ASCII を windows-1252 と誤検出する (信頼度が閾値 0.3 に届かない)。
    // 実運用のファイルに近い長さの検体で測る。
    const original = sjis('日本語のテキスト\n共通行\n');
    const r = decodeDiffPair(original, sjis('日本語のテキスト!\n共通行\n'), 'original');
    expect(r.encoding).toBe('shift_jis');
    expect(r.original).toBe('日本語のテキスト\n共通行\n');
    expect(r.modified).toBe('日本語のテキスト!\n共通行\n');
  });

  it('reports a BOM on the detection side and strips it from both texts', () => {
    const original = Buffer.concat([UTF8_BOM, Buffer.from('あ\n')]);
    const modified = Buffer.concat([UTF8_BOM, Buffer.from('い\n')]);
    const r = decodeDiffPair(original, modified, 'modified');
    expect(r.encoding).toBe('utf-8');
    expect(r.hasBom).toBe(true);
    expect(r.original).toBe('あ\n');
    expect(r.modified).toBe('い\n');
  });

  it('handles BOM-ed UTF-16LE without treating the NUL bytes as binary', () => {
    const original = Buffer.concat([UTF16LE_BOM, iconv.encode('あ\n', 'utf-16le')]);
    const modified = Buffer.concat([UTF16LE_BOM, iconv.encode('い\n', 'utf-16le')]);
    const r = decodeDiffPair(original, modified, 'modified');
    expect(r.binary).toBe(false);
    expect(r.encoding).toBe('utf-16le');
    expect(r.hasBom).toBe(true);
    expect(r.original).toBe('あ\n');
    expect(r.modified).toBe('い\n');
  });

  it('preserves CRLF exactly (no EOL normalisation happens here)', () => {
    const r = decodeDiffPair(Buffer.from('a\r\nb\r\n'), Buffer.from('a\r\nc\r\n'), 'modified');
    expect(r.original).toBe('a\r\nb\r\n');
    expect(r.modified).toBe('a\r\nc\r\n');
  });

  it('treats a NUL-containing detection side as binary', () => {
    const r = decodeDiffPair(Buffer.from('a\n'), Buffer.from([0x89, 0x50, 0x00, 0x01]), 'modified');
    expect(r).toMatchObject({ binary: true, original: '', modified: '', encoding: null });
  });

  // 検出側だけ見ていると「片方がバイナリに差し替わった」ケースを取り逃す。
  it('treats a NUL-containing non-detection side as binary too', () => {
    const r = decodeDiffPair(Buffer.from([0x00, 0x01, 0x02]), Buffer.from('a\n'), 'modified');
    expect(r.binary).toBe(true);
  });

  it('falls back to the other side when the detection side is absent (deleted)', () => {
    const r = decodeDiffPair(sjis('日本語のテキスト\n共通行\n'), null, 'modified');
    expect(r.encoding).toBe('shift_jis');
    expect(r.original).toBe('日本語のテキスト\n共通行\n');
    expect(r.modified).toBe('');
    expect(r.binary).toBe(false);
  });

  it('returns an empty added-file pair when the original is absent', () => {
    const r = decodeDiffPair(null, Buffer.from('new\n'), 'modified');
    expect(r.original).toBe('');
    expect(r.modified).toBe('new\n');
    expect(r.encoding).toBe('utf-8');
  });

  it('returns an all-empty result when both sides are absent', () => {
    const r = decodeDiffPair(null, null, 'modified');
    expect(r).toMatchObject({
      original: '',
      modified: '',
      encoding: null,
      binary: false,
      tooLarge: false,
    });
  });

  it('flags tooLarge from either side and does not decode', () => {
    const big = Buffer.alloc(MAX_FILE_SIZE + 1, 0x61);
    expect(decodeDiffPair(big, Buffer.from('a'), 'modified')).toMatchObject({
      tooLarge: true,
      original: '',
      modified: '',
    });
    expect(decodeDiffPair(Buffer.from('a'), big, 'modified')).toMatchObject({ tooLarge: true });
  });

  // ---- forcedEncoding (ステータスバーの「指定して再読み込み」) ----------------

  it('decodes both sides with a forced encoding instead of detecting', () => {
    // 自動判定なら windows-1252 に化ける短い Shift_JIS を、明示指定で正しく読む
    const original = sjis('日本語\n');
    const modified = sjis('日本語!\n');
    expect(decodeDiffPair(original, modified, 'modified').encoding).not.toBe('shift_jis'); // 対照
    const r = decodeDiffPair(original, modified, 'modified', 'shift_jis');
    expect(r.encoding).toBe('shift_jis');
    expect(r.original).toBe('日本語\n');
    expect(r.modified).toBe('日本語!\n');
    expect(r.binary).toBe(false);
  });

  it('keeps hasBom false when the forced encoding does not match the BOM present', () => {
    const buf = Buffer.concat([UTF8_BOM, Buffer.from('あ\n', 'utf8')]);
    const r = decodeDiffPair(buf, buf, 'modified', 'shift_jis');
    expect(r.encoding).toBe('shift_jis');
    // BOM は本文として見える (decodeBuffer の仕様: 指定と不一致の BOM は剥がさない)
    expect(r.hasBom).toBe(false);
  });

  it('reports hasBom when the forced encoding matches the BOM', () => {
    const buf = Buffer.concat([UTF8_BOM, Buffer.from('あ\n', 'utf8')]);
    const r = decodeDiffPair(buf, buf, 'modified', 'utf-8');
    expect(r.hasBom).toBe(true);
    expect(r.original).toBe('あ\n');
  });

  // 明示指定を binary 判定より優先させる。ここで空を返すと、誤検出されたファイルを
  // 開き直す手段そのものが失われる (BOM なし UTF-16 が該当)。
  it('does not fall back to binary when an encoding is forced', () => {
    const u16 = iconv.encode('あいうえお\nかきくけこ\n', 'utf-16le'); // BOM なし = NUL を含む
    expect(decodeDiffPair(u16, u16, 'modified').binary).toBe(true); // 対照: 自動判定では binary
    const r = decodeDiffPair(u16, u16, 'modified', 'utf-16le');
    expect(r.binary).toBe(false);
    expect(r.encoding).toBe('utf-16le');
    expect(r.original).toBe('あいうえお\nかきくけこ\n');
  });

  it('still reports tooLarge even when an encoding is forced', () => {
    const big = Buffer.alloc(MAX_FILE_SIZE + 1, 0x61);
    expect(decodeDiffPair(big, big, 'modified', 'utf-8').tooLarge).toBe(true);
  });

  it('accepts a buffer exactly at the size limit', () => {
    const atLimit = Buffer.alloc(MAX_FILE_SIZE, 0x61);
    expect(decodeDiffPair(atLimit, atLimit, 'modified').tooLarge).toBe(false);
  });
});
