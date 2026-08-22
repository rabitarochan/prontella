import type { MouseEvent } from 'react';

/** タブラベル等に使うパス末尾のファイル名。 */
export function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/**
 * `.editor-tabs` (overflow-x:auto なストリップ) に spread する。中ボタン押下の
 * 既定動作 (Chrome/Firefox のオートスクロール) を止める。タブとタブの隙間や
 * padding を「かすった」ミドルクリックでパンカーソルが出るのも防ぐため、
 * タブ単位ではなくストリップ側に置く。
 * mousedown をキャンセルしても後続の auxclick は発火する (click/auxclick は
 * mouseup の activation アルゴリズムから独立に生成されるため)。
 */
export const middleClickAutoscrollGuard = {
  onMouseDown: (e: MouseEvent) => {
    if (e.button === 1) e.preventDefault();
  },
};

/**
 * `.editor-tab` に spread する。入れ子の × ボタン (position:absolute; inset:0) の
 * 上でのミドルクリックも auxclick のバブリングでここに届くので、タブ側だけに
 * 付ける (× にも付けると二重発火する)。
 * `e.button !== 1` ガードは必須 — auxclick は右ボタン (Firefox) やサイドボタン
 * (戻る/進む, button 3/4) でも発火する。
 */
export function middleClickClose(onClose: () => void) {
  return {
    onAuxClick: (e: MouseEvent) => {
      if (e.button !== 1) return;
      e.stopPropagation();
      onClose();
    },
  };
}
