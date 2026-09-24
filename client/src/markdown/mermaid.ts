/**
 * Markdown プレビューの ```mermaid フェンスを図に描き換える後処理。
 * highlight.ts と同じ層 — render.ts (サニタイズ境界そのもの) には一切触れず、
 * サニタイズ済み DOM に対する後処理としてのみ動作する。
 *
 * mermaid が返す SVG 文字列は「mermaid が自分でサニタイズしているはず」に依存せず、
 * 必ず自前の DOMPurify に通してから DOM に入れる (highlight.ts と同じ方針)。
 *
 * 下の許可/禁止リストと mermaid 設定は、実際の出力を採って決めた (推測ではない)。
 * 2026-09-18 の実測 (mermaid 12.0.0 / flowchart・sequence・class・state・ER・gantt・pie
 * および敵対的入力):
 *   - `securityLevel: 'strict'` でも既定では <foreignObject> + HTML ラベルが出る。
 *     root-level `htmlLabels: false` を付けると 7 種すべてで foreignObject が 0 になり、
 *     ラベルは <text>/<tspan> になる (= SVG の中に HTML が一切入らなくなる)。
 *   - その状態で下の FORBID_TAGS / FORBID_ATTR を当てると、消えるのは href 属性だけで
 *     正規の描画要素は 1 つも失われない (<a> は要素として残す — mermaid は neo look で
 *     位置決めの transform を <a> に載せるため、要素ごと落とすとノードがずれる)。
 *   - `%%{init: {'themeCSS': '* { background-image: url(http://evil/) }'}}%%` を .md に
 *     書くと、その URL が <style> に載って外部リクエストが飛ぶ。mermaid の `secure` リストに
 *     themeCSS / themeVariables / theme を足すとディレクティブからの上書きが止まる。
 *     二層目として、正規の出力には fragment 参照 (url(#...)) しか現れないことを利用し、
 *     それ以外の url() をサニタイズ後に無効化する。
 *   - 構文エラーで render() が throw したとき、mermaid は一時要素 `#d<renderId>` を
 *     body に残す。呼び出し側で消さないと DOM に溜まり続ける。
 */
import DOMPurify from 'dompurify';
import type { ResolvedTheme } from '../theme/themeStore';

type Mermaid = Awaited<typeof import('mermaid')>['default'];

/** ディレクティブ (%%{init: ...}%%) から上書きさせない設定キー。mermaid 既定 +
 *  見た目とセキュリティに効くもの。theme 系を外すと CSS 注入の入り口になる (上記実測)。 */
const SECURE_KEYS = [
  'secure',
  'securityLevel',
  'startOnLoad',
  'maxTextSize',
  'maxEdges',
  'suppressErrorRendering',
  'htmlLabels',
  'theme',
  'themeCSS',
  'themeVariables',
  'fontFamily',
  'altFontFamily',
];

const FORBID_TAGS = [
  'script',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'button',
  'textarea',
  'base',
  'link',
  'meta',
  // htmlLabels: false なので正規の出力には出ない。出たら SVG 内 HTML = mXSS 面なので落とす。
  'foreignObject',
  // 外部リソースを引ける SVG 要素。正規の mermaid 出力には現れない。
  'image',
  'use',
];

const FORBID_ATTR = ['ping', 'target', 'srcset', 'formaction', 'href', 'xlink:href', 'src'];

/** CSS 文字列中の url() のうち、フラグメント参照 (url(#foo)) でないものを none に潰す。
 *  正規の mermaid 出力に現れる url() は marker / filter へのフラグメント参照だけ (実測)。 */
function neutralizeExternalUrls(css: string): string {
  return css.replace(/url\(([^)]*)\)/gi, (whole, arg: string) =>
    /^\s*['"]?#/.test(arg) ? whole : 'none',
  );
}

function neutralizeUrlsIn(root: ParentNode): void {
  for (const el of root.querySelectorAll('*')) {
    if (el.tagName.toLowerCase() === 'style') {
      const text = el.textContent ?? '';
      const next = neutralizeExternalUrls(text);
      if (next !== text) el.textContent = next;
    }
    const inline = el.getAttribute('style');
    if (inline) {
      const next = neutralizeExternalUrls(inline);
      if (next !== inline) el.setAttribute('style', next);
    }
  }
}

/** mermaid が返した SVG 文字列 → サニタイズ済み DocumentFragment。
 *  この関数だけが純関数で、mermaid.test.ts の唯一のテスト対象。 */
export function sanitizeDiagramSvg(svg: string): DocumentFragment {
  const fragment = DOMPurify.sanitize(svg, {
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS,
    FORBID_ATTR,
  });
  neutralizeUrlsIn(fragment);
  return fragment;
}

let mermaidPromise: Promise<Mermaid> | null = null;
let initializedTheme: ResolvedTheme | null = null;

/** mermaid 本体は初回だけ動的 import する (d3 / cytoscape / katex を連れてくるため
 *  初期バンドルに載せない。VncView.tsx の noVNC と同じ方針)。 */
async function ensureMermaid(theme: ResolvedTheme): Promise<Mermaid> {
  mermaidPromise ??= import('mermaid').then((m) => m.default);
  const mermaid = await mermaidPromise;
  if (initializedTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      secure: SECURE_KEYS,
      theme: theme === 'dark' ? 'dark' : 'default',
    });
    initializedTheme = theme;
  }
  return mermaid;
}

let seq = 0;

/**
 * `pre` (= <pre class="md-code">) を、描画した図に差し替える。失敗したら元のコードブロックを
 * そのまま残す (= 常に「ソースが読める」状態には戻れる)。
 *
 * 世代管理は highlight.ts と同じ `isConnected` ガード。呼び出し元は再描画のたびに
 * `container.replaceChildren()` で古い DOM を切り離すので、await から戻った時点で
 * 切り離されていたら書き込まない。
 */
export async function renderMermaidInto(pre: HTMLElement, code: string, theme: ResolvedTheme): Promise<void> {
  const renderId = `md-mermaid-${++seq}`;
  try {
    const mermaid = await ensureMermaid(theme);
    if (!pre.isConnected) return; // 待っている間に古い描画になった
    const { svg } = await mermaid.render(renderId, code);
    if (!pre.isConnected) return;
    const host = document.createElement('div');
    host.className = 'md-mermaid';
    host.appendChild(sanitizeDiagramSvg(svg));
    pre.replaceWith(host);
  } catch (err) {
    if (!pre.isConnected) return;
    // 構文エラーのときは図にせず、元のコードブロックを残したまま理由だけ添える
    // (新規の i18n 文言を増やさないため、mermaid のメッセージをそのまま title に入れる)。
    pre.classList.add('md-mermaid-failed');
    pre.title = err instanceof Error ? err.message : String(err);
  } finally {
    // render() が throw すると mermaid は一時要素を body に残す (実測)。成功時は自分で
    // 片付けるので、ここは no-op になる。
    document.getElementById(`d${renderId}`)?.remove();
  }
}
