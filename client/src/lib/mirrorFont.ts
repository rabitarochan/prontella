/**
 * 追従 (鏡写し) 中のターミナルのフォントサイズを解く純関数。
 *
 * FitAddon は「枠に合わせて cols/rows を決める」が、PTY のサイズを主張できない
 * ページでは逆に「cols/rows は固定で、格子が枠に収まる最大のフォントサイズを探す」。
 * 実際のセル寸法はレンダラーが決める (フォント計測 + 丸め) ので、ここでは
 * `probe(fontSize)` に格子の実寸を返してもらい、比例推定を起点に ±1 で有界探索する。
 * セル寸法はフォントサイズに対して単調なので、通常 2〜3 回の probe で収束する。
 *
 * 拡大はしない (max = 通常のフォントサイズ)。worktree ページが追従側に回ったとき、
 * 小さな格子が大きな枠いっぱいに膨らんで見た目が跳ねるのを避けるため。
 */

export const BASE_FONT_SIZE = 13;
export const MIRROR_FONT_MIN = 6;
export const MIRROR_FONT_MAX = BASE_FONT_SIZE;

export interface Box {
  width: number;
  height: number;
}

/** 格子 (cols × rows) の実寸 (px)。 */
export interface GridSize {
  width: number;
  height: number;
}

/** フォントサイズを適用して格子の実寸を返す。計測できなければ null。 */
export type ProbeFn = (fontSize: number) => GridSize | null;

export interface SolveOptions {
  min: number;
  max: number;
  /** probe の呼び出し上限 (初期計測を含む)。 */
  maxProbes: number;
}

export const DEFAULT_SOLVE_OPTIONS: SolveOptions = {
  min: MIRROR_FONT_MIN,
  max: MIRROR_FONT_MAX,
  maxProbes: 6,
};

/**
 * 最小フォントでも格子が枠に収まらないときの残りを CSS transform で縮める倍率 (≤ 1)。
 * 収まっていれば 1 (transform なし)。フォントを 6px 未満にしてもどうせ読めないので、
 * 文字の描画はそこで止めて、全体像 (どこまで出力が進んだか・ダイアログの有無) が
 * 見えることを優先する。追従側 = 非アクティブなページなので、transform 下で
 * マウス座標がずれる問題は実用上起きない (クリックした瞬間にアクティブへ遷移して
 * 主張側に戻り、transform は外れる)。
 */
export function mirrorScale(box: Box, screen: GridSize): number {
  if (!(box.width > 0) || !(box.height > 0) || !(screen.width > 0) || !(screen.height > 0)) return 1;
  return Math.min(1, box.width / screen.width, box.height / screen.height);
}

function valid(size: GridSize | null | undefined): size is GridSize {
  return !!size && size.width > 0 && size.height > 0;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * 枠 `box` に格子が収まる最大の整数フォントサイズを返す。
 * 枠が 0×0 (未レイアウト / display:none) か計測不能なら null。
 * 最小サイズでも収まらないときは min を返す (それ以上は縮められない)。
 *
 * 呼び出し側の契約: 戻り値と最後に probe したサイズは一致しないことがあるので、
 * 戻り値を改めて適用すること (mirrorFontDom.refitMirror が行う)。
 */
export function solveMirrorFontSize(
  box: Box,
  current: { fontSize: number; screen: GridSize | null },
  probe: ProbeFn,
  opts: SolveOptions = DEFAULT_SOLVE_OPTIONS,
): number | null {
  if (!(box.width > 0) || !(box.height > 0)) return null;
  const { min, max, maxProbes } = opts;
  let probes = 0;
  const cache = new Map<number, GridSize | null>();
  const measure = (fs: number): GridSize | null | undefined => {
    if (cache.has(fs)) return cache.get(fs);
    if (probes >= maxProbes) return undefined;
    probes++;
    const size = probe(fs);
    const result = valid(size) ? size : null;
    cache.set(fs, result);
    return result;
  };
  const fits = (fs: number): boolean | undefined => {
    const size = measure(fs);
    if (size === undefined) return undefined;
    if (size === null) return false;
    return size.width <= box.width && size.height <= box.height;
  };

  let screen: GridSize | null;
  if (valid(current.screen)) {
    screen = current.screen;
    cache.set(current.fontSize, screen);
  } else {
    screen = measure(current.fontSize) ?? null;
  }
  if (!screen) return null;

  const scale = Math.min(box.width / screen.width, box.height / screen.height);
  let guess = clamp(Math.floor(current.fontSize * scale), min, max);

  const first = fits(guess);
  if (first === undefined) return min;
  if (first) {
    while (guess < max) {
      const next = fits(guess + 1);
      if (next !== true) break;
      guess++;
    }
    return guess;
  }
  while (guess > min) {
    guess--;
    const ok = fits(guess);
    if (ok === true) return guess;
    if (ok === undefined) return min;
  }
  return min;
}
