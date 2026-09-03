import type { Terminal } from '@xterm/xterm';
import { BASE_FONT_SIZE, mirrorScale, solveMirrorFontSize, type Box, type GridSize } from './mirrorFont';

/**
 * mirrorFont の DOM アダプター。
 *
 * `term.options.fontSize = n` は同期で CharSizeService の再計測 → RenderService →
 * レンダラーの `_updateDimensions()` まで走り、`.xterm-screen` の inline
 * `style.width/height` に `cols × cellW` / `rows × cellH` が書かれる
 * (xterm 5.5: DomRenderer.ts:151-152 / addon-webgl WebglRenderer.ts:186-187。
 * 描画そのものは rAF に合流するので、1 tick で数回 probe しても paint は 1 回)。
 * FitAddon が読む `_core._renderService.dimensions` (private) には触らず、
 * この公開 DOM を格子の実寸として読む。
 */

const SCREEN_SELECTOR = '.xterm-screen';
// xterm 6 のスクロールバーは VS Code 由来のオーバーレイで、DOM の offsetWidth −
// clientWidth では測れない。FitAddon 0.11 と同じ規則 (scrollback が 0 なら 0、
// それ以外は overviewRuler.width か既定 14px) で控除する。
const DEFAULT_SCROLL_BAR_WIDTH = 14;

/** `.xterm-screen` の格子実寸。inline style を優先し、無ければレイアウト寸法にフォールバック。 */
export function readScreenSize(term: Terminal): GridSize | null {
  const screen = term.element?.querySelector<HTMLElement>(SCREEN_SELECTOR);
  if (!screen) return null;
  const width = parseFloat(screen.style.width) || screen.offsetWidth;
  const height = parseFloat(screen.style.height) || screen.offsetHeight;
  if (!(width > 0) || !(height > 0)) return null;
  return { width, height };
}

/** 格子を収めるべき枠 = コンテナ内寸 − padding − スクロールバー幅 (FitAddon と同じ控除)。 */
export function mirrorBox(term: Terminal, container: HTMLElement): Box {
  const cs = getComputedStyle(container);
  const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  const scrollbar =
    term.options.scrollback === 0 ? 0 : term.options.overviewRuler?.width || DEFAULT_SCROLL_BAR_WIDTH;
  return {
    width: container.clientWidth - padX - scrollbar,
    height: container.clientHeight - padY,
  };
}

/** 追従側の transform を外す (主張側へ戻るとき、fit の前に呼ぶ)。 */
export function clearMirrorScale(term: Terminal): void {
  const el = term.element;
  if (el && el.style.transform) {
    el.style.transform = '';
    el.style.transformOrigin = '';
  }
}

/**
 * 格子 (term.cols × term.rows) が container に収まるようフォントサイズを縮める。
 * 最小フォントでも収まらない残りは `.xterm` 要素の transform: scale で縮める
 * (mirrorScale)。適用したフォントサイズを返す。枠が未確定なら何もせず null。
 */
export function refitMirror(term: Terminal, container: HTMLElement): number | null {
  const box = mirrorBox(term, container);
  const result = solveMirrorFontSize(
    box,
    { fontSize: term.options.fontSize ?? BASE_FONT_SIZE, screen: readScreenSize(term) },
    (fontSize) => {
      term.options.fontSize = fontSize;
      return readScreenSize(term);
    },
  );
  if (result === null) return null;
  if (term.options.fontSize !== result) term.options.fontSize = result;
  const el = term.element;
  const screen = readScreenSize(term);
  if (el && screen) {
    const scale = mirrorScale(box, screen);
    if (scale < 1) {
      el.style.transformOrigin = '0 0';
      el.style.transform = `scale(${scale.toFixed(4)})`;
    } else {
      clearMirrorScale(term);
    }
  }
  return result;
}
