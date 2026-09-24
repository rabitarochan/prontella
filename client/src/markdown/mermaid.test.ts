// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { sanitizeDiagramSvg } from './mermaid';

/** サニタイズ済みフラグメントを HTML 文字列に戻す (アサート用)。 */
function html(fragment: DocumentFragment): string {
  const holder = document.createElement('div');
  holder.appendChild(fragment);
  return holder.innerHTML;
}

function svg(inner: string): string {
  return `<svg id="d1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="graphics-document">${inner}</svg>`;
}

describe('sanitizeDiagramSvg — 危険な入力を落とす', () => {
  it('<script> を残さない', () => {
    const out = html(sanitizeDiagramSvg(svg('<script>alert(1)</script><path d="M0 0"/>')));
    expect(out).not.toContain('<script');
    expect(out).toContain('<path');
  });

  it('イベントハンドラー属性を残さない', () => {
    const out = html(sanitizeDiagramSvg(svg('<rect onload="alert(1)" onclick="alert(2)" width="10"/>')));
    expect(out).not.toMatch(/on(load|click)=/i);
    expect(out).toContain('width="10"');
  });

  it('<foreignObject> を残さない (htmlLabels: false で正規の出力には現れない)', () => {
    const out = html(sanitizeDiagramSvg(svg('<foreignObject><div><img src="x" onerror="alert(1)"></div></foreignObject>')));
    expect(out.toLowerCase()).not.toContain('foreignobject');
    expect(out).not.toContain('onerror');
  });

  it('href / xlink:href を残さない (javascript: も含めて丸ごと)', () => {
    const out = html(
      sanitizeDiagramSvg(svg('<a href="javascript:alert(1)" xlink:href="javascript:alert(2)" transform="translate(1,2)"><text>x</text></a>')),
    );
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('href');
    // <a> 自体は残す — mermaid はノードの位置決め transform を <a> に載せるため
    expect(out).toContain('transform="translate(1,2)"');
  });

  it('<image> / <use> を残さない (外部リソースを引ける SVG 要素)', () => {
    const out = html(sanitizeDiagramSvg(svg('<image href="http://evil.test/a.png"/><use href="http://evil.test/b#x"/>')));
    expect(out).not.toContain('<image');
    expect(out).not.toContain('<use');
  });

  it('<iframe> / <object> / <embed> / <form> を残さない', () => {
    const out = html(
      sanitizeDiagramSvg(svg('<iframe src="http://evil.test"></iframe><object data="x"></object><embed src="x"><form action="x"></form>')),
    );
    for (const tag of ['<iframe', '<object', '<embed', '<form']) expect(out).not.toContain(tag);
  });
});

describe('sanitizeDiagramSvg — 外部 URL による通信を起こさせない', () => {
  it('<style> の中の外部 url() を潰す', () => {
    const out = html(sanitizeDiagramSvg(svg('<style>* { background-image: url(http://evil.test/a.png); }</style>')));
    expect(out).not.toContain('evil.test');
    expect(out).toContain('none');
  });

  it('style 属性の中の外部 url() を潰す', () => {
    const out = html(sanitizeDiagramSvg(svg('<rect style="fill: red; filter: url(\'https://evil.test/b.svg#f\')"/>')));
    expect(out).not.toContain('evil.test');
    expect(out).toContain('fill: red');
  });

  it('プロトコル相対・データ URL も潰す', () => {
    const out = html(
      sanitizeDiagramSvg(svg('<style>a{background:url(//evil.test/c.png)}b{background:url("data:image/svg+xml,<svg/>")}</style>')),
    );
    expect(out).not.toContain('evil.test');
    expect(out).not.toContain('data:image');
  });

  it('フラグメント参照の url(#...) は残す (marker / filter が壊れるため)', () => {
    const out = html(sanitizeDiagramSvg(svg('<path marker-end="url(#arrow)" style="filter: url(#drop-shadow)"/>')));
    expect(out).toContain('url(#arrow)');
    expect(out).toContain('url(#drop-shadow)');
  });
});

describe('sanitizeDiagramSvg — 正規の mermaid 出力を壊さない', () => {
  it('描画に必要な要素と属性をすべて残す', () => {
    const out = html(
      sanitizeDiagramSvg(
        svg(
          [
            '<style>#d1 .node rect{fill:#eee}</style>',
            '<defs><marker id="arrow" refX="8" refY="5" markerWidth="12" markerHeight="12" orient="auto"><path d="M0 0L10 5L0 10z"/></marker>',
            '<filter id="ds"><feDropShadow dx="1" dy="1" stdDeviation="2" flood-color="#000" flood-opacity="0.3"/></filter>',
            '<symbol id="s"><circle cx="5" cy="5" r="4"/></symbol></defs>',
            '<g class="node" data-id="A" transform="translate(10,20)">',
            '<rect width="40" height="20" rx="3" ry="3" stroke="#333" stroke-width="1" fill="#fff"/>',
            '<polygon points="0,0 4,8 8,0"/><line x1="0" y1="0" x2="9" y2="9" stroke-dasharray="3,2"/>',
            '<text text-anchor="middle" dominant-baseline="middle" font-size="14" x="1" y="2" dy="0.3em"><tspan>Start</tspan></text>',
            '</g>',
          ].join(''),
        ),
      ),
    );
    // 要素名の大小は HTML パーサーの foreign content 調整に依存する (jsdom は
    // feDropShadow を小文字に落とすが実ブラウザーは camelCase を保つ) ので、
    // 要素名だけ大小無視で見る。実ブラウザーでの見え方は E2E 側で確認する。
    expect(out).toMatch(/<fedropshadow/i);
    for (const needle of [
      '<style',
      '<marker',
      'refX="8"',
      'markerWidth="12"',
      'orient="auto"',
      'stdDeviation="2"',
      'flood-color="#000"',
      '<symbol',
      'data-id="A"',
      'transform="translate(10,20)"',
      'stroke-dasharray="3,2"',
      'dominant-baseline="middle"',
      '<tspan',
      'Start',
    ]) {
      expect(out, `missing ${needle}`).toContain(needle);
    }
  });

  it('role / aria-* を残す (mermaid がアクセシビリティ情報を載せる)', () => {
    const out = html(sanitizeDiagramSvg(svg('<g role="graphics-object" aria-roledescription="node"></g>')));
    expect(out).toContain('role="graphics-object"');
    expect(out).toContain('aria-roledescription="node"');
  });
});
