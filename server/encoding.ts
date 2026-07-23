import iconv from 'iconv-lite';
import * as jschardet from 'jschardet';

/** ステータスバーのエンコーディングメニュー(client 側)と一致させるホワイトリスト。 */
export const SUPPORTED_ENCODINGS = [
  'utf-8',
  'shift_jis',
  'euc-jp',
  'utf-16le',
  'utf-16be',
  'windows-1252',
];

// jschardet の信頼度がこれ未満なら utf-8 フォールバック(誤検出はクライアントの
// 「エンコーディング指定で再読み込み」で手動修正できるので、閾値は低めで攻めない)
const MIN_CONFIDENCE = 0.3;
const DETECT_SAMPLE = 64 * 1024;

const BOMS: { encoding: string; bytes: number[] }[] = [
  { encoding: 'utf-8', bytes: [0xef, 0xbb, 0xbf] },
  { encoding: 'utf-16le', bytes: [0xff, 0xfe] },
  { encoding: 'utf-16be', bytes: [0xfe, 0xff] },
];

// jschardet の検出名(小文字化) → iconv-lite の名前。ここにないもの
// (ISO-2022-JP, Big5 など iconv-lite 非対応も含む)は utf-8 フォールバック。
const DETECTED_NAME_MAP: Record<string, string> = {
  ascii: 'utf-8',
  'utf-8': 'utf-8',
  shift_jis: 'shift_jis',
  'euc-jp': 'euc-jp',
  'windows-1252': 'windows-1252',
  'iso-8859-1': 'windows-1252', // windows-1252 は ISO-8859-1 の上位互換
  'utf-16le': 'utf-16le',
  'utf-16be': 'utf-16be',
};

export interface DecodedText {
  content: string;
  encoding: string; // iconv-lite 正規化名(SUPPORTED_ENCODINGS のいずれか)
  hasBom: boolean;
}

export function normalizeEncoding(name: string): string {
  const lower = name.trim().toLowerCase();
  if (!SUPPORTED_ENCODINGS.includes(lower)) {
    throw new Error(`サポートされていないエンコーディングです: ${name}`);
  }
  return lower;
}

function bomOf(buf: Buffer): { encoding: string; length: number } | null {
  for (const { encoding, bytes } of BOMS) {
    if (buf.length >= bytes.length && bytes.every((b, i) => buf[i] === b)) {
      return { encoding, length: bytes.length };
    }
  }
  return null;
}

/**
 * バッファをテキストとしてデコードする。null はバイナリ判定。
 * forcedEncoding は「エンコーディング指定で再読み込み」用で、バイナリ判定より
 * 優先される(NUL を含む BOM なし UTF-16 をユーザーが開き直せる余地を残す)。
 */
export function decodeBuffer(buf: Buffer, forcedEncoding?: string): DecodedText | null {
  const bom = bomOf(buf);
  if (forcedEncoding) {
    const enc = normalizeEncoding(forcedEncoding);
    // 指定と一致する BOM だけ本文から外して保持。不一致の BOM は本文として見せる
    // (指定が正しければ文字化けとして現れ、ユーザーが気付ける)。
    if (bom && bom.encoding === enc) {
      return { content: iconv.decode(buf.subarray(bom.length), enc), encoding: enc, hasBom: true };
    }
    return { content: iconv.decode(buf, enc), encoding: enc, hasBom: false };
  }
  if (bom) {
    return {
      content: iconv.decode(buf.subarray(bom.length), bom.encoding),
      encoding: bom.encoding,
      hasBom: true,
    };
  }
  // BOM なしで NUL を含むものはバイナリ(BOM 付き UTF-16 は上で除外済み)
  if (buf.includes(0)) return null;
  // 純 ASCII に jschardet をかけても意味がないので即 utf-8
  if (!buf.some((b) => b >= 0x80)) {
    return { content: buf.toString('utf8'), encoding: 'utf-8', hasBom: false };
  }
  const detected = jschardet.detect(buf.subarray(0, DETECT_SAMPLE));
  const mapped =
    detected.encoding && detected.confidence >= MIN_CONFIDENCE
      ? DETECTED_NAME_MAP[detected.encoding.toLowerCase()]
      : undefined;
  const enc = mapped ?? 'utf-8';
  return { content: iconv.decode(buf, enc), encoding: enc, hasBom: false };
}

/**
 * 既知のエンコーディング名(SUPPORTED_ENCODINGS のいずれか)でバッファを文字列にデコードする。
 * decodeBuffer と違い自動判定・BOM 検出は行わない(呼び出し側が既に検出済みのエンコーディングを
 * 使い回して 1 行ずつデコードする用途、例: server/git.ts の blame 行内容)。
 */
export function decodeWithEncoding(buf: Buffer, encoding: string): string {
  return iconv.decode(buf, normalizeEncoding(encoding));
}

/**
 * テキストをエンコードする。BOM は iconv-lite に任せず自前で結合する
 * (utf-16 系の addBOM 既定挙動に依存しない)。エンコード先で表現できない
 * 文字(例: Shift_JIS に絵文字)は iconv-lite の仕様で '?' に置換される。
 */
export function encodeText(content: string, encoding: string, withBom: boolean): Buffer {
  const enc = normalizeEncoding(encoding);
  const body = iconv.encode(content, enc);
  if (!withBom) return body;
  const bom = BOMS.find((b) => b.encoding === enc);
  return bom ? Buffer.concat([Buffer.from(bom.bytes), body]) : body;
}
