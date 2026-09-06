// ターミナルが枠より小さく表示される事象の採取用。
//
// 使い方: 事象が起きている状態のまま、ブラウザーの DevTools コンソールに
// このファイルの中身を貼って実行し、出力をそのまま共有する。
// **読み取りのみ** — ターミナルにも PTY にも一切触れない。
//
// 何を見るためのものか:
//   XTermView には「主張側 / 追従側」がある。非アクティブなページでは
//   fit.fit() を呼ばず、refitMirror がフォントを縮めるだけ (拡大はしない)。
//   そのため追従側に回ったまま復帰し損ねると
//   「フォントは通常サイズなのに格子 (cols×rows) が枠より小さい」状態が残る。
//   一方、最小フォントでも収まらないときは .xterm に transform: scale が付く。
//   この 2 つは原因が違うので、どちらなのかを区別する。
//
// 読み方:
//   transform が入っている        → 追従側の縮小が残っている
//   transform なし & fontSize 13  & screen が container より明らかに小さい
//                                 → 格子が古い (fit.fit() が走っていない)
//   fontSize が 13 未満           → 追従側のフォント縮小が残っている
(() => {
  const num = (v) => (v == null ? null : Math.round(v * 100) / 100);
  const terms = [...document.querySelectorAll('.xterm')].map((x, i) => {
    const box = x.parentElement;
    const screen = x.querySelector('.xterm-screen');
    const r = screen ? screen.getBoundingClientRect() : null;
    // フォントサイズの読み先は 2 つある。WebGL レンダラーだと .xterm-rows が
    // canvas に置き換わって消えるので、xterm が常に持つ計測用要素を優先する。
    const measure = x.querySelector('.xterm-char-measure-element');
    const rows = x.querySelector('.xterm-rows');
    const fontEl = measure ?? rows ?? x;
    const cs = getComputedStyle(fontEl);
    // セル寸法。これが分かれば格子の px から cols/rows を割り出せる —
    // 「cols が古い」のか「フォントが縮められた」のかはこれでしか分けられない。
    const cell = measure
      ? { w: num(measure.getBoundingClientRect().width), h: num(measure.getBoundingClientRect().height) }
      : null;
    const sw = screen ? parseFloat(screen.style.width) : null;
    const sh = screen ? parseFloat(screen.style.height) : null;
    return {
      i,
      // 枠 (この大きさに格子が収まるべき)
      container: box ? [box.clientWidth, box.clientHeight] : null,
      // xterm が書いた格子の実寸 (inline style)
      screenStyle: screen ? [screen.style.width, screen.style.height] : null,
      // 実際に描かれている大きさ (transform 込み)
      screenRect: r ? [Math.round(r.width), Math.round(r.height)] : null,
      transform: x.style.transform || null,
      fontSize: cs.fontSize,
      fontSizeFrom: measure ? 'char-measure' : rows ? 'xterm-rows' : 'xterm',
      cell,
      // 現在の格子と、枠いっぱいに入るはずの格子。ズレていれば fit が走っていない
      gridNow: cell && sw && sh ? [Math.floor(sw / cell.w), Math.floor(sh / cell.h)] : null,
      gridFits:
        cell && box
          ? [Math.floor((box.clientWidth - 14) / cell.w), Math.floor(box.clientHeight / cell.h)]
          : null,
      renderer: screen?.querySelector('canvas') ? 'canvas/webgl' : 'dom',
      hiddenNow: box ? box.offsetWidth === 0 : null,
      // 枠に対してどれだけ余っているか (これが大きいほど「縮んで見える」)
      slack:
        box && r ? [Math.round(box.clientWidth - r.width), Math.round(box.clientHeight - r.height)] : null,
    };
  });
  const out = {
    page: {
      visibility: document.visibilityState,
      hasFocus: document.hasFocus(),
      pageActive: document.visibilityState === 'visible' && document.hasFocus(),
      dpr: window.devicePixelRatio,
    },
    terms,
  };
  console.log(JSON.stringify(out, null, 1));
  return out;
})();
