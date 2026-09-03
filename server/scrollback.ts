/**
 * PTY 出力の末尾 `max` 文字を保持するリングバッファ。
 *
 * 以前は `scrollback = (scrollback + data).slice(-MAX)` だった。V8 は連結を
 * ロープで遅延するが `slice` が平坦化を強制するため、チャンクが届くたびに
 * 200k 文字 (UTF-16 で 400 KB) のコピーが走っていた。Claude Code の稼働中は
 * スピナーで毎秒十数チャンク出るので、セッション数に比例して CPU を食う。
 *
 * ここではチャンクの配列と合計長だけを持ち、末尾 `max` 文字を「覆う」最小の
 * チャンク列を保つ。結合は attach 時 (`snapshot()`) にだけ行う。
 * 保持量は `max` を最大 1 チャンク分だけ超えうる (先頭チャンクを部分的に切らないため)。
 */
export class ScrollbackBuffer {
  private chunks: string[] = [];
  private total = 0;

  constructor(private readonly max: number) {
    if (!(max > 0)) throw new RangeError('max must be positive');
  }

  append(data: string): void {
    if (data.length === 0) return;
    if (data.length >= this.max) {
      // 1 チャンクで上限を超える: それ以前は全部落ちる
      this.chunks = [data.slice(-this.max)];
      this.total = this.max;
      return;
    }
    this.chunks.push(data);
    this.total += data.length;
    // 先頭チャンクを丸ごと落としても末尾 max 文字が残るなら落とす
    while (this.chunks.length > 1 && this.total - this.chunks[0].length >= this.max) {
      this.total -= this.chunks[0].length;
      this.chunks.shift();
    }
  }

  /** 保持している文字数 (max を超えることがある — snapshot() が切り詰める)。 */
  get length(): number {
    return this.total;
  }

  /** 末尾 max 文字。旧実装の `(...).slice(-max)` と同じ結果。 */
  snapshot(): string {
    const joined = this.chunks.length === 1 ? this.chunks[0] : this.chunks.join('');
    return joined.length > this.max ? joined.slice(-this.max) : joined;
  }
}
