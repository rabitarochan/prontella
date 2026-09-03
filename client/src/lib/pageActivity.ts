import { create } from 'zustand';

/**
 * 「このページ (document) は今アクティブか」= 可視かつフォーカスあり。
 *
 * PTY の winsize は 1 つしかないので、同じセッションを複数のタブ / ウィンドウで
 * 開いているときは**アクティブなページだけがサイズを主張する** (XTermView の
 * sendResize)。非アクティブなページはサーバーが配る実サイズに格子を合わせて
 * 鏡写しする。同一ブラウザーの 2 ウィンドウが同時にフォーカスを持つことはない
 * ため、「表示している方」の一意な判定になる。
 *
 * liveSocket の wireGlobalProbes と同じく、リスナーはプロセスで 1 度だけ配線する。
 */

interface PageActivityState {
  active: boolean;
}

function computeActive(): boolean {
  if (typeof document === 'undefined') return true;
  return document.visibilityState === 'visible' && document.hasFocus();
}

export const usePageActivity = create<PageActivityState>(() => ({ active: computeActive() }));

let wired = false;

export function wirePageActivity(): void {
  if (wired || typeof window === 'undefined') return;
  wired = true;
  const update = () => {
    const active = computeActive();
    if (usePageActivity.getState().active !== active) usePageActivity.setState({ active });
  };
  document.addEventListener('visibilitychange', update);
  window.addEventListener('focus', update);
  window.addEventListener('blur', update);
}
