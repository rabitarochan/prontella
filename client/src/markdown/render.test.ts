// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderMarkdownToFragment, type RenderCtx } from './render';

const baseCtx: RenderCtx = {
  mdPath: 'docs/guide.md',
  root: '/repo',
  allowExternalImages: false,
};

function render(source: string, ctx: Partial<RenderCtx> = {}): DocumentFragment {
  return renderMarkdownToFragment(source, { ...baseCtx, ...ctx });
}

/** フラグメント全体 (全要素・全属性) を走査し、on* イベントハンドラー属性を収集する。 */
function collectEventHandlerAttrs(fragment: DocumentFragment): string[] {
  const found: string[] = [];
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode() as Element | null;
  while (node) {
    for (const attr of Array.from(node.attributes)) {
      if (attr.name.toLowerCase().startsWith('on')) {
        found.push(`${node.tagName}:${attr.name}`);
      }
    }
    node = walker.nextNode() as Element | null;
  }
  return found;
}

describe('renderMarkdownToFragment — sanitization', () => {
  it('drops <script> tags entirely', () => {
    const frag = render('before <script>alert(1)</script> after');
    expect(frag.querySelectorAll('script')).toHaveLength(0);
  });

  it('strips onerror from <img onerror=...>', () => {
    const frag = render('<img src=x onerror=alert(1)>');
    const img = frag.querySelector('img');
    // html:false なので生 HTML はテキストとして扱われ img 要素自体が生まれない可能性が高いが、
    // 万一要素化されても onerror 属性が残らないことを検証する。
    if (img) {
      expect(img.getAttribute('onerror')).toBeNull();
    } else {
      expect(frag.querySelectorAll('img')).toHaveLength(0);
    }
  });

  it('drops iframe / object / embed / form / style tags', () => {
    const frag = render(
      ['<iframe src="x"></iframe>', '<object data="x"></object>', '<embed src="x">', '<form></form>', '<style>a{}</style>'].join(
        '\n\n',
      ),
    );
    expect(frag.querySelectorAll('iframe')).toHaveLength(0);
    expect(frag.querySelectorAll('object')).toHaveLength(0);
    expect(frag.querySelectorAll('embed')).toHaveLength(0);
    expect(frag.querySelectorAll('form')).toHaveLength(0);
    expect(frag.querySelectorAll('style')).toHaveLength(0);
  });

  it('blocks a javascript: link: no data-deck-* attribute anywhere in the output', () => {
    const frag = render('[x](javascript:alert(1))');
    // markdown-it 自身のパーサーはリンク先のスキーム検査 (validateLink) に失敗すると、
    // href を空文字に潰した上で pos を戻さない実装のため、この構文全体がリンクとして
    // パースされず素のテキスト "[x](javascript:alert(1))" にフォールバックする
    // (<a> 自体が生成されない)。<a> の有無に関わらず data-deck-* が一切現れないことを
    // 保証する (万一将来 markdown-it 側の挙動が変わって <a> が生成されても安全なように)。
    const a = frag.querySelector('a');
    if (a) {
      expect(a.getAttribute('href')).toBe('#');
      expect(a.hasAttribute('data-deck-link')).toBe(false);
      expect(a.hasAttribute('data-deck-external')).toBe(false);
    }
    expect(frag.querySelectorAll('[data-deck-link]')).toHaveLength(0);
    expect(frag.querySelectorAll('[data-deck-external]')).toHaveLength(0);
  });

  // 回帰テスト: markdown-it の validateLink は javascript: を検知すると href をトークン
  // 生成前に空文字 '' に潰す (rules_inline/link.mjs)。classifyHref がその空文字を
  // 「ディレクトリーにしか解決しない入力」として blocked としない限り、resolveRelative('')
  // が「現在のディレクトリーを指す relative」を返してしまい data-deck-link が生成される
  // 誤分類バグが起きる (paths.ts の isBlank / isDirectoryOnlyTarget が本来の修正箇所)。
  it('blocks an empty link target [x](): no data-deck-* attribute', () => {
    const frag = render('[x]()');
    const a = frag.querySelector('a');
    expect(a).not.toBeNull();
    expect(a!.getAttribute('href')).toBe('#');
    expect(a!.hasAttribute('data-deck-link')).toBe(false);
    expect(a!.hasAttribute('data-deck-external')).toBe(false);
  });

  it('blocks a directory-only link target [x](.): no data-deck-* attribute', () => {
    const frag = render('[x](.)');
    const a = frag.querySelector('a');
    expect(a).not.toBeNull();
    expect(a!.getAttribute('href')).toBe('#');
    expect(a!.hasAttribute('data-deck-link')).toBe(false);
    expect(a!.hasAttribute('data-deck-external')).toBe(false);
  });

  // 敵対的フィクスチャで見つかった欠陥の回帰テスト: "java%09script:alert(1)" は markdown-it
  // 自身の validateLink (生の文字列に対する BAD_PROTO_RE 判定) をすり抜けるため <a> トークン
  // 自体は生成されるが、classifyHref (paths.ts) 側のパーセントデコード後スキーム判定で
  // blocked と判定され、href="#" のまま data-deck-* が一切付かないことを固定する。
  it('blocks a percent-encoded obfuscated javascript: link [x](java%09script:alert(1)): no data-deck-* attribute', () => {
    const frag = render('[x](java%09script:alert(1))');
    const a = frag.querySelector('a');
    expect(a).not.toBeNull();
    expect(a!.getAttribute('href')).toBe('#');
    expect(a!.hasAttribute('data-deck-link')).toBe(false);
    expect(a!.hasAttribute('data-deck-external')).toBe(false);
  });

  it('leaves no on* event handler attributes anywhere in the output for a <div onmouseover=...>', () => {
    const frag = render('<div onmouseover="alert(1)">hi</div>');
    expect(collectEventHandlerAttrs(frag)).toEqual([]);
  });
});

describe('renderMarkdownToFragment — images', () => {
  it('rewrites a relative image src to /api/fs/raw?...', () => {
    const frag = render('![](./img/a.png)');
    const img = frag.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('/api/fs/raw?root=%2Frepo&path=docs%2Fimg%2Fa.png');
  });

  it('does not render an <img> for a root-escaping relative image', () => {
    const frag = render('![](../../../etc/passwd)');
    expect(frag.querySelectorAll('img')).toHaveLength(0);
  });

  it('renders 0 <img> elements for an external image when allowExternalImages is false', () => {
    const frag = render('![](https://example.com/a.png)', { allowExternalImages: false });
    expect(frag.querySelectorAll('img')).toHaveLength(0);
  });

  it('renders 1 <img> element for an external image when allowExternalImages is true', () => {
    const frag = render('![](https://example.com/a.png)', { allowExternalImages: true });
    const imgs = frag.querySelectorAll('img');
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute('src')).toBe('https://example.com/a.png');
  });

  it('does not render an <img> for ![](javascript:alert(1)) (blocked scheme)', () => {
    const frag = render('![](javascript:alert(1))', { allowExternalImages: true });
    expect(frag.querySelectorAll('img')).toHaveLength(0);
  });

  // 敵対的フィクスチャで見つかった欠陥の回帰テスト (画像経路)。"java%09script:alert(1)" は
  // markdown-it 自身の validateLink (生の文字列に対する判定) をすり抜けて image トークンが
  // 生成されるが、classifyHref 側のパーセントデコード後スキーム判定で blocked になり、
  // <img> 要素が一切生成されない (src に何も入らない、というより <img> 自体が無い) こと
  // を固定する。
  it('does not render an <img> for a percent-encoded obfuscated javascript scheme ![](java%09script:alert(1))', () => {
    const frag = render('![](java%09script:alert(1))', { allowExternalImages: true });
    expect(frag.querySelectorAll('img')).toHaveLength(0);
  });

  it('does not render an <img> for a percent-encoded scheme-prefix obfuscation ![](%6Aavascript:alert(1))', () => {
    const frag = render('![](%6Aavascript:alert(1))', { allowExternalImages: true });
    expect(frag.querySelectorAll('img')).toHaveLength(0);
  });

  it('does not render an <img> for an empty image target ![]()', () => {
    const frag = render('![]()');
    expect(frag.querySelectorAll('img')).toHaveLength(0);
  });

  // R-4 (敵対的レビューで発見): resolveRelative が '\' をパス区切りとして扱っておらず、
  // '..%5C..%5Csecret.png' (パーセントエンコードされた '..\..\') が root 外を指すのに
  // relative に誤分類されていた。画像経路 (classifyHref の呼び出し元は render.ts の
  // image ルール) でも同じ結論 (<img> 非生成) になることを固定する。
  it('does not render an <img> for a percent-encoded backslash traversal ![](..%5C..%5Csecret.png)', () => {
    const frag = render('![](..%5C..%5Csecret.png)', { allowExternalImages: true });
    expect(frag.querySelectorAll('img')).toHaveLength(0);
  });

  // R-5 (敵対的レビューで発見): '//' で始まるプロトコル相対 URL の遮断が生の文字列にしか
  // 適用されておらず、UNC パスのパーセントエンコード形 ('%5C%5Chost%5Cshare%5Ca.png' は
  // decodeUntilStable + normalizeBackslashes を経て '//host/share/a.png' になる) がすり
  // 抜けていた。画像経路でも同じ結論 (<img> 非生成) になることを固定する。
  it('does not render an <img> for a percent-encoded UNC path ![](%5C%5Chost%5Cshare%5Ca.png)', () => {
    const frag = render('![](%5C%5Chost%5Cshare%5Ca.png)', { allowExternalImages: true });
    expect(frag.querySelectorAll('img')).toHaveLength(0);
  });

  // markdown-it 既定の validateLink は data:image/(gif|png|jpeg|webp) を画像に限り許可する
  // (GOOD_DATA_RE) ため href は潰されず生の data: URL がそのまま渡ってくる。それでも
  // classifyHref は http/https 以外を external にしないので、最終的に <img> は生成されない
  // ことを固定する (markdown-it 側の "許可" がこちらまで素通りしないことの確認)。
  it('does not render an <img> for a data:image/png URL even though markdown-it itself allows it for images', () => {
    const frag = render('![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA)', { allowExternalImages: true });
    expect(frag.querySelectorAll('img')).toHaveLength(0);
  });
});

describe('renderMarkdownToFragment — links', () => {
  it('rewrites a relative link: href="#" and data-deck-link="other.md"', () => {
    const frag = render('[a](./other.md)', { mdPath: 'README.md' });
    const a = frag.querySelector('a');
    expect(a).not.toBeNull();
    expect(a!.getAttribute('href')).toBe('#');
    expect(a!.getAttribute('data-deck-link')).toBe('other.md');
  });

  it('rewrites an external link: href="#" and data-deck-external set', () => {
    const frag = render('[a](https://example.com/)');
    const a = frag.querySelector('a');
    expect(a).not.toBeNull();
    expect(a!.getAttribute('href')).toBe('#');
    expect(a!.getAttribute('data-deck-external')).toBe('https://example.com/');
  });
});

describe('renderMarkdownToFragment — fenced code', () => {
  it('produces <code data-lang="ts"> with the fence contents escaped as text, not as an element', () => {
    const frag = render(['```ts', '<script>alert(1)</script>', '```'].join('\n'));
    const code = frag.querySelector('code[data-lang="ts"]');
    expect(code).not.toBeNull();
    expect(code!.querySelectorAll('script')).toHaveLength(0);
    expect(code!.textContent).toBe('<script>alert(1)</script>\n');
  });
});

describe('renderMarkdownToFragment — GFM', () => {
  it('renders a GFM table as <table>', () => {
    const frag = render(['| a | b |', '| - | - |', '| 1 | 2 |'].join('\n'));
    expect(frag.querySelectorAll('table')).toHaveLength(1);
  });

  it('renders a task list checkbox as a disabled <input>', () => {
    const frag = render(['- [ ] todo', '- [x] done'].join('\n'));
    const inputs = frag.querySelectorAll('input[type="checkbox"]');
    expect(inputs).toHaveLength(2);
    for (const input of Array.from(inputs)) {
      expect(input.hasAttribute('disabled')).toBe(true);
    }
  });

  it('renders ~~x~~ as <del>', () => {
    const frag = render('~~x~~');
    expect(frag.querySelectorAll('del')).toHaveLength(1);
    expect(frag.querySelector('s')).toBeNull();
  });
});
