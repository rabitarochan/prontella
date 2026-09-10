/**
 * ファイルパネルのガター差分 (VS Code の dirty diff 相当) 用の行単位 diff。
 * 純関数のみ (vitest 対象)。Monaco にも git にも依存しない。
 *
 * 入力中に毎回走るので、O(ND) の Myers を共通 prefix/suffix トリムの後にだけ掛け、
 * 編集距離が大きすぎる場合は諦めて null を返す (装飾を出さない方が、入力が詰まるより良い)。
 */

export type LineChangeKind = 'add' | 'modify' | 'delete';

export interface LineChange {
  kind: LineChangeKind;
  /** 現在の文書 (cur) の 1 始まり行番号。両端を含む。 */
  startLine: number;
  endLine: number;
}

/** 行数の上限。これを超えるファイルでは装飾を出さない。 */
export const MAX_DIFF_LINES = 50_000;
/** Myers の編集距離の上限。全面書き換えのような入力で O(N^2) に張り付くのを防ぐ。 */
export const MAX_EDIT_DISTANCE = 3_000;

/**
 * 行分割。**行末は CRLF / LF のどちらでも同一視する**。
 * core.autocrlf=true の作業ツリーでは index の blob (LF) と作業ツリー (CRLF) の行末が
 * 食い違い得るので、ここを行末非依存にしておかないと全行が変更として点灯する。
 * (git cat-file --filters で揃えてはいるが、そちらは git のバージョンや属性設定に依存する。
 *  表示の正しさを片方の仕組みだけに賭けない。)
 */
export function splitLinesForDiff(text: string): string[] {
  return text.split(/\r?\n/);
}

/** 内部表現: 編集スクリプトの 1 要素。 */
interface EditRun {
  /** base 側で消えた行数 */
  del: number;
  /** cur 側で増えた行数 */
  add: number;
  /** cur 側でこの塊が始まる 0 始まり添字 */
  curStart: number;
}

/**
 * base と cur の行差分を求め、**cur の座標系**の変更範囲として返す。
 * 返り値が null なら「大きすぎるので装飾しない」。差分が無ければ空配列。
 *
 * - add: cur にだけある行の連なり
 * - modify: base の行が cur の行に置き換わった連なり (del と add が隣接する塊)
 * - delete: base にだけあった行 (cur には実体が無いので、削除位置の直前行に 1 行だけ張る。
 *   先頭が削除された場合は 1 行目に寄せる。VS Code の三角マークと同じ考え方)
 */
export function computeLineChanges(base: string[], cur: string[]): LineChange[] | null {
  if (base.length > MAX_DIFF_LINES || cur.length > MAX_DIFF_LINES) return null;

  // 共通 prefix / suffix をトリムする。編集は局所的なことがほとんどなので、
  // これだけで Myers に渡す長さが劇的に減る。
  let prefix = 0;
  const maxPrefix = Math.min(base.length, cur.length);
  while (prefix < maxPrefix && base[prefix] === cur[prefix]) prefix++;
  let suffix = 0;
  const maxSuffix = Math.min(base.length, cur.length) - prefix;
  while (suffix < maxSuffix && base[base.length - 1 - suffix] === cur[cur.length - 1 - suffix]) {
    suffix++;
  }

  const a = base.slice(prefix, base.length - suffix);
  const b = cur.slice(prefix, cur.length - suffix);
  if (a.length === 0 && b.length === 0) return [];

  const runs = a.length === 0
    ? [{ del: 0, add: b.length, curStart: 0 }]
    : b.length === 0
      ? [{ del: a.length, add: 0, curStart: 0 }]
      : myersRuns(a, b);
  if (runs === null) return null;

  const out: LineChange[] = [];
  for (const run of runs) {
    // cur の 1 始まり行番号へ戻す (トリムした prefix 分を足す)。
    const start = prefix + run.curStart + 1;
    if (run.add > 0 && run.del > 0) {
      out.push({ kind: 'modify', startLine: start, endLine: start + run.add - 1 });
    } else if (run.add > 0) {
      out.push({ kind: 'add', startLine: start, endLine: start + run.add - 1 });
    } else if (run.del > 0) {
      // cur 側に実体が無い。削除位置の直前行に印を付ける (先頭なら 1 行目)。
      const anchor = Math.max(1, Math.min(start - 1, cur.length));
      out.push({ kind: 'delete', startLine: anchor, endLine: anchor });
    }
  }
  return out;
}

/**
 * Myers の O(ND) 差分。編集スクリプトを「隣接する削除+追加をひとまとめにした塊」の
 * 列として返す。距離が MAX_EDIT_DISTANCE を超えたら null (呼び出し側で諦める)。
 */
function myersRuns(a: string[], b: string[]): EditRun[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max;
  const size = 2 * max + 1;
  const v = new Int32Array(size);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const idx = k + offset;
      if (idx < 0 || idx >= size) continue;
      let x: number;
      if (k === -d || (k !== d && v[idx - 1] < v[idx + 1])) {
        x = v[idx + 1]; // down = b 側を 1 つ進める (挿入)
      } else {
        x = v[idx - 1] + 1; // right = a 側を 1 つ進める (削除)
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[idx] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, d, offset, size);
    }
  }
  return null; // 距離が上限を超えた
}

/** trace から編集スクリプトを復元し、削除/追加の連なりを塊にまとめる。 */
function backtrack(
  trace: Int32Array[],
  a: string[],
  b: string[],
  d: number,
  offset: number,
  size: number,
): EditRun[] {
  // (x, y) を終点から遡って、削除 (a を消費) / 挿入 (b を消費) を逆順に集める。
  const ops: { kind: 'del' | 'add'; x: number; y: number }[] = [];
  let x = a.length;
  let y = b.length;
  for (let step = d; step > 0; step--) {
    const vPrev = trace[step];
    const k = x - y;
    const idx = k + offset;
    let prevK: number;
    if (k === -step || (k !== step && idx - 1 >= 0 && idx + 1 < size && vPrev[idx - 1] < vPrev[idx + 1])) {
      prevK = k + 1; // 直前は挿入
    } else {
      prevK = k - 1; // 直前は削除
    }
    const prevX = vPrev[prevK + offset];
    const prevY = prevX - prevK;
    // 対角線 (一致) 部分を戻す
    while (x > prevX && y > prevY) {
      x--;
      y--;
    }
    if (x === prevX) {
      ops.push({ kind: 'add', x, y: y - 1 });
      y = prevY;
    } else {
      ops.push({ kind: 'del', x: x - 1, y });
      x = prevX;
    }
  }
  ops.reverse();

  // 各 op は「その編集を行う直前の (base 添字, cur 添字)」を持つ。先頭から歩き直し、
  // op の位置がウォーカーの現在位置と一致していれば直前の塊の続き、ずれていれば
  // その間に一致行 (対角線) が挟まっている = 塊の切れ目、と判定する。
  // ops の隣接を場当たりに見るのではなく、一致行の有無で切るのが正しい判別器。
  const runs: EditRun[] = [];
  let bx = 0;
  let by = 0;
  let current: EditRun | null = null;
  for (const op of ops) {
    if (op.x !== bx || op.y !== by) {
      // 一致行を挟んだので塊を切る
      current = null;
      bx = op.x;
      by = op.y;
    }
    if (!current) {
      current = { del: 0, add: 0, curStart: by };
      runs.push(current);
    }
    if (op.kind === 'del') {
      current.del++;
      bx++;
    } else {
      current.add++;
      by++;
    }
  }
  return runs;
}
