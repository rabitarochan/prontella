/**
 * LSP の stdio フレーミング (`Content-Length: N\r\n\r\n<body>`)。
 *
 * N は**バイト数**であって文字数ではない。文字列連結でバッファリングすると、日本語を含む
 * hover / 補完の本文でマルチバイト文字の途中で切れて必ず壊れる。Buffer のまま溜めて、
 * 1 通ぶん確定してから utf8 にデコードする。
 *
 * チャンク境界は保証されない (ヘッダーが 2 分割 / 1 チャンクに 3 通 / ボディが 1 バイトずつ)。
 * 不正な Content-Length は復帰を試みず onError に渡す — フレームに同期点が無いので、
 * 読み飛ばしは必ず二次被害になる。呼び出し側はプロセスごと捨てる。
 */

const HEADER_END = Buffer.from('\r\n\r\n');

export interface MessageReader {
  push(chunk: Buffer): void;
}

export function createMessageReader(
  onMessage: (msg: unknown) => void,
  onError: (err: Error) => void,
): MessageReader {
  let buf: Buffer = Buffer.alloc(0);
  let dead = false;
  return {
    push(chunk) {
      if (dead) return;
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      for (;;) {
        const hdrEnd = buf.indexOf(HEADER_END);
        if (hdrEnd < 0) return;
        const length = contentLength(buf.subarray(0, hdrEnd).toString('ascii'));
        if (length === null) {
          dead = true;
          onError(new Error(`不正な LSP ヘッダー: ${JSON.stringify(buf.subarray(0, hdrEnd).toString('ascii'))}`));
          return;
        }
        const bodyStart = hdrEnd + HEADER_END.length;
        if (buf.length < bodyStart + length) return;
        const body = buf.subarray(bodyStart, bodyStart + length).toString('utf8');
        buf = buf.subarray(bodyStart + length);
        let msg: unknown;
        try {
          msg = JSON.parse(body);
        } catch (e) {
          dead = true;
          onError(new Error(`不正な LSP 本文: ${e instanceof Error ? e.message : String(e)}`));
          return;
        }
        onMessage(msg);
      }
    },
  };
}

/** ヘッダーブロックから content-length を拾う。未知ヘッダーは無視。無い/不正なら null。 */
function contentLength(header: string): number | null {
  for (const line of header.split('\r\n')) {
    const sep = line.indexOf(':');
    if (sep < 0) continue;
    if (line.slice(0, sep).trim().toLowerCase() !== 'content-length') continue;
    const value = line.slice(sep + 1).trim();
    if (!/^\d+$/.test(value)) return null;
    return Number(value);
  }
  return null;
}

export function encodeMessage(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}
