import { decodeBuffer, decodeWithEncoding } from './encoding.js';
import { MAX_FILE_SIZE } from './files.js';

/**
 * 差分の左右 2 つのバイト列を「同じエンコーディングで」テキスト化する純関数(vitest 対象)。
 *
 * **なぜ片側だけで検出するのか**: 左右を独立に自動判定すると、同じファイルの 2 版なのに
 * 判定がぶれて(jschardet はサンプル依存)片方だけ化け、全行が変更として表示され得る。
 * 検出は 1 回だけ行い、その結果を両側に適用する。
 *
 * **なぜ decodeWithEncoding を使うのか**: もう一方に decodeBuffer をかけ直すと再検出が走る。
 * 既知のエンコーディングで一括デコードする経路は server/git.ts の decodeBlameContent と同じ思想。
 *
 * バイナリ判定は「検出側が decodeBuffer で null」= NUL を含む(BOM 付き UTF-16 は除く)。
 * 非検出側だけが NUL を含むケース(片側だけバイナリに差し替わった等)も binary に倒す —
 * ただし UTF-16 系は本文に NUL を含むのが正常なので除外する。
 */

export interface DecodedPair {
  original: string;
  modified: string;
  /** 検出できたエンコーディング(SUPPORTED_ENCODINGS のいずれか)。binary/両側 null なら null。 */
  encoding: string | null;
  /** 検出側に BOM が付いていたか。保存時に BOM を維持するために使う。 */
  hasBom: boolean;
  binary: boolean;
  tooLarge: boolean;
}

const EMPTY: DecodedPair = {
  original: '',
  modified: '',
  encoding: null,
  hasBom: false,
  binary: false,
  tooLarge: false,
};

function isUtf16(encoding: string): boolean {
  return encoding === 'utf-16le' || encoding === 'utf-16be';
}

export function decodeDiffPair(
  originalBuf: Buffer | null,
  modifiedBuf: Buffer | null,
  detectFrom: 'modified' | 'original',
  /**
   * ステータスバーの「エンコーディングを指定して再読み込み」用。指定すると自動判定を
   * 行わず、この名前で**両側を**デコードする。files.ts の readFileContent の
   * forcedEncoding と同じ意味論で、decodeBuffer の仕様上バイナリ判定より優先される
   * (BOM なし UTF-16 を開き直せる余地を残すため)。
   */
  forcedEncoding?: string,
): DecodedPair {
  if ((originalBuf?.length ?? 0) > MAX_FILE_SIZE || (modifiedBuf?.length ?? 0) > MAX_FILE_SIZE) {
    return { ...EMPTY, tooLarge: true };
  }
  // 検出側が無い(その版に存在しない = 追加/削除)ときは他方へフォールバックする。
  const primary = detectFrom === 'modified' ? modifiedBuf : originalBuf;
  const secondary = detectFrom === 'modified' ? originalBuf : modifiedBuf;
  const detectionBuf = primary ?? secondary;
  if (!detectionBuf) return EMPTY; // 両側とも存在しない

  const detected = decodeBuffer(detectionBuf, forcedEncoding);
  if (!detected) return { ...EMPTY, binary: true };

  // 検出に使わなかった側 (存在すれば)。UTF-16 は本文に NUL を含むのが正常なので除外する。
  // 明示指定があるときは binary へ倒さない — ユーザーが「この文字コードで読め」と
  // 言っているのに空表示になると、指定し直す手段そのものが失われる。
  const other = originalBuf === detectionBuf ? modifiedBuf : originalBuf;
  if (!forcedEncoding && other && !isUtf16(detected.encoding) && other.includes(0)) {
    return { ...EMPTY, binary: true };
  }

  // 存在しない側 (その版に無い = 追加/削除) は空文字列。検出に使ったバッファーは
  // decodeBuffer の結果をそのまま使い、もう一方は同じエンコーディングで別途デコードする。
  // decodeWithEncoding は BOM を自前で剥がさないが、iconv-lite の decode() は
  // utf-8/utf-16le/utf-16be の先頭 BOM を無条件に除去する
  // (server/git.ts の decodeBlameContent で実測済み)。
  const decode = (buf: Buffer | null): string => {
    if (!buf) return '';
    if (buf === detectionBuf) return detected.content;
    return decodeWithEncoding(buf, detected.encoding);
  };

  return {
    original: decode(originalBuf),
    modified: decode(modifiedBuf),
    encoding: detected.encoding,
    hasBom: detected.hasBom,
    binary: false,
    tooLarge: false,
  };
}
