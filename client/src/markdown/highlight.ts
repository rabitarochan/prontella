/**
 * Markdown プレビューのコードブロック用シンタックスハイライト (T7)。
 * render.ts (サニタイズ境界そのもの) はここでは一切変更しない — サニタイズ済みの
 * DOM に対する後処理としてのみ動作する、差し替え可能な唯一の窓口。
 *
 * 方式: monaco.editor.colorize() を使う (新規依存ゼロ・エディター本体と配色が完全に
 * 一致する)。colorize() の戻り値は文字列 (HTML) だが、「monaco が自分でエスケープする
 * はず」には依存しない — 必ず DOMPurify の極小許可リスト (span/br の class のみ) に
 * 通してから DOM に書き込む。これにより、万一 colorize() の出力に想定外のタグ/属性が
 * 混入しても DOM への注入経路にはならない。
 */
import * as monaco from 'monaco-editor';
import { monacoThemeName } from '../theme/monacoTheme';
import { useTheme } from '../theme/themeStore';
import DOMPurify from 'dompurify';

// フェンスの情報文字列 (```ts / ```bash など) → monaco の言語 ID への逆引き索引。
// monaco-setup.ts の languageFor はファイル名/拡張子からの解決であり、フェンストークン
// (自由文字列、必ずしも拡張子と一致しない) には流用できない。monaco.languages.getLanguages()
// の id / aliases[] / extensions[] (先頭の '.' を除いたもの) をすべて小文字化して
// 索引を作る。モジュール初期化時に 1 回だけ構築する (呼び出しのたびに作り直さない)。
let langIndex: Map<string, string> | null = null;

function buildLangIndex(): Map<string, string> {
  const index = new Map<string, string>();
  for (const lang of monaco.languages.getLanguages()) {
    index.set(lang.id.toLowerCase(), lang.id);
    for (const alias of lang.aliases ?? []) {
      const key = alias.toLowerCase();
      if (!index.has(key)) index.set(key, lang.id);
    }
    for (const ext of lang.extensions ?? []) {
      const key = ext.toLowerCase().replace(/^\./, '');
      if (!index.has(key)) index.set(key, lang.id);
    }
  }
  return index;
}

/** フェンスの情報文字列トークンを monaco の言語 ID に解決する。未知なら undefined。 */
function resolveLanguageId(token: string): string | undefined {
  if (!langIndex) langIndex = buildLangIndex();
  return langIndex.get(token.toLowerCase());
}

let themeEnsured = false;

/**
 * `.mtkN` (colorize の出力が参照するトークン配色クラス) の CSS は
 * `<style class="monaco-colors">` としてエディターインスタンスが 1 度でも生成されないと
 * DOM に注入されない (monaco の実装上の制約)。プレビュータブしか開いていないセッションでは
 * colorize() 自体は動くが結果がモノクロになってしまう。
 *
 * オフスクリーンの極小エディターを 1 度だけ生成して即 dispose することで、この副作用
 * (テーマ CSS の注入) だけを起こす。1 セッションで 1 回行えば十分 (dispose してもいったん
 * 注入された <style> 要素は残る)。
 */
export function ensureColorizeTheme(): void {
  if (themeEnsured) return;
  if (document.querySelector('style.monaco-colors')) {
    themeEnsured = true;
    return;
  }
  monaco.editor.setTheme(monacoThemeName(useTheme.getState().resolved));
  const host = document.createElement('div');
  host.style.position = 'fixed';
  host.style.top = '-10000px';
  host.style.left = '-10000px';
  host.style.width = '10px';
  host.style.height = '10px';
  host.style.overflow = 'hidden';
  document.body.appendChild(host);
  const editor = monaco.editor.create(host, {
    value: '',
    theme: monacoThemeName(useTheme.getState().resolved),
    automaticLayout: false,
  });
  editor.dispose();
  host.remove();
  themeEnsured = true;
}

// 言語ごとに「起こす」処理 (下記) を 1 セッションにつき 1 回だけ行うためのガード。
const wokenLanguages = new Set<string>();

/**
 * V-1 (2026-07-27 レビュー指摘) の根本原因と対処。
 *
 * 実測した根本原因: monaco-editor の言語登録には 2 通りある。
 * - ts/bash など basic-languages 系は `languages.registerTokensProviderFactory()` を
 *   **モジュール読み込み時に同期的に**登録する (中身の import() は非同期でも、
 *   「登録の受付」自体は最初から済んでいる)。colorize() 内部の
 *   `TokenizationRegistry.getOrCreate()` はこのファクトリーを見つけて await するので、
 *   初回呼び出しでも正しく待って本物のトークナイズ結果を返す。
 * - json (と monaco-setup.ts で worker を割り当てている css/html/typescript の
 *   LSP 側) は `languages.onLanguage(id, () => import('./xxxMode.js').then(m =>
 *   m.setupMode(...)))` という形で登録される。この `onLanguage` イベントは
 *   「その言語のモデルが初めて作られたとき」にしか発火しない —
 *   colorize() はモデルを作らないため、一度もエディターでその言語のファイルを
 *   開いていないセッションでは `setTokensProvider` 自体が永久に呼ばれず、
 *   colorize() は毎回 `TokenizationRegistry.getOrCreate()` が何も見つけられず
 *   fake colorize (行ごとに 1 span、mtk1 固定 = 無配色) にフォールバックし続ける。
 *   一度でも実エディターでその言語のファイルを開く (= モデルが作られる) と
 *   以降ずっと正常化するのは、まさにこの一度きりの `onLanguage` が発火するため。
 *
 * 対処: `monaco.editor.createModel('', languageId)` を作って即 dispose し、
 * 「初めてモデルが作られた」イベントを人為的に起こす (ensureColorizeTheme と同じ
 * 発想)。ただし `onLanguage` のコールバックが発火した時点では
 * `import('./xxxMode.js').then(...)` の **完了** はまだ保証されない
 * (発火は「開始」の合図であって「完了」の合図ではなく、かつ TokenizationRegistry は
 * 公開 API から直接 await できない)。そのため「盲目的に 1 回だけ待ってリトライ」は
 * せず、実際に colorize() を呼んで **fake か本物かを判定し、fake である間だけ
 * 短い間隔でポーリングし続ける** (上限 2 秒。遅いマシンでも壊れないよう、固定回数の
 * リトライではなく期限までポーリングする形にしている)。fake の判定は
 * 「生成された <span> 数が行数以下」— colorizer.js の _fakeColorize は必ず
 * 1 行につき 1 span (mtk1 固定) しか作らないため、本物のトークナイズなら
 * (空行でもない限り) 行数を上回る span 数になる。
 */
async function warmUpLanguage(languageId: string): Promise<void> {
  if (wokenLanguages.has(languageId)) return;
  wokenLanguages.add(languageId);
  const model = monaco.editor.createModel('', languageId);
  model.dispose();
}

function countSpans(html: string): number {
  return (html.match(/<span class="mtk/g) ?? []).length;
}

const WARM_UP_POLL_MS = 30;
const WARM_UP_DEADLINE_MS = 2000;

/**
 * `el.textContent` (プレーンテキスト。HTML ではない) を colorize し、DOMPurify で
 * span/br のみの極小許可リストへ通してから `el` へ書き込む。
 *
 * 世代管理: 呼び出し元 (MarkdownPreview) が再描画のたびに `container.replaceChildren()`
 * で古い DOM を丸ごと切り離すため、この関数に渡された `el` が「もう古い描画の一部
 * (= document から切り離し済み)」であることは `el.isConnected` だけで判定できる —
 * 新しい描画は常に新しい DOM ノードを作る (同じ el を使い回さない) ので、
 * `await` から戻った時点で `el.isConnected` が false なら、アンマウント済み・
 * 上書き済みのどちらでも「もう書き込んではいけない」を意味する。setState は使わず、
 * ここで直接 DOM に書き込むだけなので、React 側の後始末を待つ必要もない。
 */
export async function highlightInto(el: HTMLElement, code: string, lang: string): Promise<void> {
  const languageId = resolveLanguageId(lang);
  if (!languageId) return; // 未知の言語トークンはプレーン表示のまま (呼び出し元の初期表示を変えない)

  ensureColorizeTheme();
  await warmUpLanguage(languageId);

  const lineCount = Math.max(1, code.split('\n').length);
  let html = await monaco.editor.colorize(code, languageId, { tabSize: 4 });
  const deadline = Date.now() + WARM_UP_DEADLINE_MS;
  while (countSpans(html) <= lineCount && Date.now() < deadline) {
    if (!el.isConnected) return; // 待っている間に古い描画になった (再描画 / アンマウント)
    await new Promise((r) => setTimeout(r, WARM_UP_POLL_MS));
    html = await monaco.editor.colorize(code, languageId, { tabSize: 4 });
  }
  if (!el.isConnected) return; // 待っている間に古い描画になった (再描画 / アンマウント)

  const fragment = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['span', 'br'],
    ALLOWED_ATTR: ['class'],
    RETURN_DOM_FRAGMENT: true,
  });
  if (!el.isConnected) return; // sanitize 自体は同期だが、直前の判定と対にして書き込み直前にも確認する
  el.replaceChildren(fragment);
}
