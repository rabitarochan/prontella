import * as serializeNs from '@xterm/addon-serialize';
import * as headlessNs from '@xterm/headless';

// どちらも CJS バンドルで、Node の ESM からは名前付き import が解決できない
// (cjs-module-lexer が export を検出できず `default` = module.exports だけになる。
// vitest / esbuild は変換して通してしまうので実行時にだけ壊れる)。
// 名前空間 import の `default` を優先し、無ければ名前付きを使う。
type Terminal = headlessNs.Terminal;
type SerializeAddon = serializeNs.SerializeAddon;
const { Terminal } = (headlessNs as unknown as { default?: typeof headlessNs }).default ?? headlessNs;
const { SerializeAddon } =
  (serializeNs as unknown as { default?: typeof serializeNs }).default ?? serializeNs;

/**
 * PTY 出力をサーバー側でも xterm (headless) に食わせておき、attach 時に
 * 「画面 + スクロールバック + DEC モード」を ANSI にシリアライズして渡す。
 *
 * 以前は生出力の末尾 200k 文字を再生していた。Claude Code (Ink) は同じ領域を
 * 毎秒十数回描き直すので、その 200k の大半は上書きされて消える再描画で、
 * クライアントは attach のたびにそれを全部パースしていた (モニターで N 本同時)。
 * シリアライズ結果は「いま見えているもの」だけなので、量は再描画の回数に
 * 依存せず、DEC モード (bracketed paste 等) の追跡も serialize 側が担う。
 * VS Code の persistent terminal と同じ構成 (xterm-headless + addon-serialize)。
 *
 * write は xterm の WriteBuffer 経由で非同期 (setTimeout 0 で刻む) なので、
 * snapshot() は空 write のコールバックで「ここまで処理済み」を待ってから
 * serialize する。呼び出し側はその間に届いた出力を別途バッファする必要がある
 * (pty.ts の attach がそれをやる)。
 */
export class ScreenMirror {
  private readonly term: Terminal;
  private readonly serializer: SerializeAddon;
  private disposed = false;

  constructor(cols: number, rows: number, scrollback: number) {
    this.term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
  }

  write(data: string): void {
    if (this.disposed) return;
    this.term.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    if (this.term.cols === cols && this.term.rows === rows) return;
    this.term.resize(cols, rows);
  }

  get cols(): number {
    return this.term.cols;
  }

  get rows(): number {
    return this.term.rows;
  }

  /**
   * ここまでに write した出力を処理し終えた時点の画面を ANSI 文字列で返す
   * (コールバック)。dispose 済みなら呼ばれない。
   */
  snapshot(cb: (data: string) => void): void {
    if (this.disposed) return;
    this.term.write('', () => {
      if (this.disposed) return;
      cb(this.serializer.serialize());
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.term.dispose();
  }
}
