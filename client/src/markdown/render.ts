/**
 * Markdown ソース文字列をサニタイズ済みの DocumentFragment に変換する、プレビュー機能の
 * セキュリティ境界そのもの。DOM への注入経路はここが返す DocumentFragment のみとし、
 * innerHTML / insertAdjacentHTML 等の文字列注入はこのモジュール内で一切行わない。
 *
 * レンダリング用シンタックスハイライト (コードブロックの着色) はここでは行わない —
 * サニタイズ済み DOM に対する後処理として別モジュール (T7) が担当する。
 */
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import DOMPurify from 'dompurify';
import { classifyHref } from './paths';
import { api } from '../api';

export interface RenderCtx {
  /** root 相対の .md パス。相対リンク・画像パス解決の基準になる。 */
  mdPath: string;
  /** ワークツリーの絶対パス (rawUrl のクエリ組み立て用)。 */
  root: string;
  /** true なら http(s) 画像をそのまま <img> で出す。false のときは <img> を一切生成せず、
   *  ブラウザーからのリクエストが 1 件も発生しないことを保証する。 */
  allowExternalImages: boolean;
}

// markdown-it インスタンスはモジュールトップレベルに 1 個だけ生成する (レンダリングの
// たびに new しない)。GFM の表・打ち消し線は既定で有効 (打ち消し線は既定だと <s> になる
// ため下で <del> に上書きする)、自動リンクは linkify、タスクリストは
// markdown-it-task-lists プラグインを使う。チェックボックスは enabled:false のまま =
// 常に disabled 属性つきで生成される。
const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false }).use(taskLists, {
  enabled: false,
  label: true,
});

// markdown-it 既定の validateLink はあえて上書きしない (二層防御の 1 層目として使う)。
// validateLink は javascript: / vbscript: / file: / (非画像)data: を検知すると、
// トークンを作る前に href を空文字 '' へ潰す (rules_inline/link.mjs, image.mjs)。
// classifyHref (paths.ts) 側は href='' を「ディレクトリーにしか解決しない入力」として
// 明示的に blocked とするようになっているため、この 2 つを組み合わせると:
//   - markdown-it の scheme 検査が効けば → href='' → classifyHref がここで blocked
//   - 万一 markdown-it 側の検査をすり抜けても → 生の href が来る → classifyHref 自身の
//     scheme 判定 (http/https 以外は blocked) がここで blocked
// のどちらか一方が欠けてももう一方が blocked に到達させる。過去に
// `md.validateLink = () => true` として 1 層目を無効化していたが、classifyHref 側の
// 空文字/ディレクトリー限定判定が無かった当時は href='' が「現在のディレクトリーを指す
// relative」に誤分類されるバグがあったため一時的にそうしていた。classifyHref 側の
// 修正により根本原因が解消されたので、ここでは markdown-it 既定の検査をそのまま活かす。

// レンダリング中だけ有効なコンテキスト。renderMarkdownToFragment は同期関数であり、
// markdown-it の render() 呼び出し中に別の render 呼び出しが割り込むことはない
// (JS のシングルスレッド性 + 非同期処理を挟まない実装) ため、モジュールスコープの
// 一時変数として安全に扱える。
let activeCtx: RenderCtx | null = null;

function requireCtx(): RenderCtx {
  if (!activeCtx) {
    throw new Error('markdown render rule invoked outside of renderMarkdownToFragment');
  }
  return activeCtx;
}

/** フェンスの情報文字列 (例: "ts" / "tsx foo=bar") の先頭トークンだけを取り出し、
 *  英数字・+ ・- ・# ・. 以外の文字を除去する。着色はここでは行わない (T7 の担当)。 */
function sanitizeLangToken(rawInfo: string): string {
  const firstToken = rawInfo.trim().split(/\s+/)[0] ?? '';
  return firstToken.replace(/[^A-Za-z0-9+#.-]/g, '');
}

md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx];
  const escaped = md.utils.escapeHtml(token.content);
  const lang = sanitizeLangToken(token.info || '');
  const langAttr = lang ? ` data-lang="${md.utils.escapeHtml(lang)}"` : '';
  return `<pre class="md-code"><code${langAttr}>${escaped}</code></pre>\n`;
};

// GFM の打ち消し線 (~~x~~) は markdown-it 組み込みだと <s> になるため <del> に上書きする。
md.renderer.rules.s_open = () => '<del>';
md.renderer.rules.s_close = () => '</del>';

md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const ctx = requireCtx();
  const token = tokens[idx];
  const altText = md.utils.escapeHtml(self.renderInlineAsText(token.children ?? [], options, env));
  // markdown-it 15 の attrGet は string | number | null を返す (attrSet が number を
  // 受けるため型が広がった)。パーサー由来の src は常に文字列だが、型を絞るため String() を通す。
  const srcRaw = String(token.attrGet('src') ?? '');
  const kind = classifyHref(ctx.mdPath, srcRaw);

  if (kind.kind === 'relative') {
    const src = api.rawUrl(ctx.root, kind.path);
    return `<img src="${md.utils.escapeHtml(src)}" alt="${altText}">`;
  }

  if (kind.kind === 'external') {
    if (ctx.allowExternalImages) {
      return `<img src="${md.utils.escapeHtml(kind.url)}" alt="${altText}">`;
    }
    // allowExternalImages=false のときはリクエストを 1 件も発生させないため <img> を
    // 一切生成せず、alt テキストとホスト名だけのプレースホルダーに置き換える。
    let host = kind.url;
    try {
      host = new URL(kind.url).host || kind.url;
    } catch {
      // URL として解釈できない場合は元の文字列をそのまま表示する。
    }
    const label = altText ? `${altText} ` : '';
    return `<span class="md-image-blocked" title="${md.utils.escapeHtml(kind.url)}">${label}(${md.utils.escapeHtml(host)})</span>`;
  }

  // blocked / anchor 等: <img> は生成せず alt テキストのみ残す。
  return altText;
};

md.renderer.rules.link_open = (tokens, idx) => {
  const ctx = requireCtx();
  const token = tokens[idx];
  // src と同様、markdown-it 15 の attrGet は string | number | null を返す。
  const hrefRaw = String(token.attrGet('href') ?? '');
  const kind = classifyHref(ctx.mdPath, hrefRaw);

  const attrs = ['href="#"'];
  let title = '';
  if (kind.kind === 'relative') {
    attrs.push(`data-deck-link="${md.utils.escapeHtml(kind.path)}"`);
    title = kind.path;
  } else if (kind.kind === 'external') {
    attrs.push(`data-deck-external="${md.utils.escapeHtml(kind.url)}"`);
    title = kind.url;
  }
  // anchor / blocked: data-deck-* は付けない。title も (blocked の生スキームをわざわざ
  // 見せる理由が無いため) 付けない。
  if (title) attrs.push(`title="${md.utils.escapeHtml(title)}"`);

  return `<a ${attrs.join(' ')}>`;
};
md.renderer.rules.link_close = () => '</a>';

export function renderMarkdownToFragment(source: string, ctx: RenderCtx): DocumentFragment {
  activeCtx = ctx;
  try {
    const html = md.render(source);
    return DOMPurify.sanitize(html, {
      RETURN_DOM_FRAGMENT: true,
      FORBID_TAGS: ['form', 'iframe', 'object', 'embed', 'style', 'script'],
      FORBID_ATTR: ['style', 'srcset', 'ping', 'target'],
    });
  } finally {
    activeCtx = null;
  }
}
