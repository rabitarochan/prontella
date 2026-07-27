import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { renderMarkdownToFragment } from '../markdown/render';
import { highlightInto } from '../markdown/highlight';
import { isMarkdownPath } from '../markdown/paths';

export interface MarkdownPreviewProps {
  /** ワークツリー絶対パス。相対リンク・画像パス解決 (renderMarkdownToFragment) にそのまま渡す。 */
  root: string;
  /** root 相対の .md パス。 */
  path: string;
  /** 表示する Markdown 本文。null は読み込み中を表す。 */
  source: string | null;
  /** 読み込みエラーメッセージ。あればプレースホルダーとして表示する。 */
  error?: string;
  /** 2MB 超などの理由で読めなかった。 */
  tooLarge?: boolean;
  /** バイナリファイル (拡張子が .md でも中身がバイナリ扱いされたケースなど)。 */
  binary?: boolean;
  /** ツールバーの「更新」ボタン。 */
  onRefresh: () => void;
  /** data-deck-link かつ .md/.markdown のリンクをクリックしたとき (新しいプレビュータブ)。 */
  onOpenPreview: (path: string) => void;
  /** data-deck-link かつそれ以外のリンクをクリックしたとき (エディタータブ)。 */
  onOpenFile: (path: string) => void;
  /**
   * プレビュー本文のスクロール位置 (path → scrollTop)。メモリのみ (localStorage 等へは
   * 永続化しない)。呼び出し側 (FilesTab) が所有する Map をそのまま渡してもらい、
   * このコンポーネントは直接読み書きする。R-3 (2026-07-27 レビュー指摘): このコンポーネント
   * 自身に持たせていた頃は、アクティブタブがエディターに切り替わった瞬間 unmount され
   * state ごと失われていた (プレビュー同士の切替では同一インスタンスを使い回すため
   * 気づきにくい)。FilesTab はプレビュー/エディター間の切替でも unmount しないので、
   * そちら側の ref を渡してもらうことでタブ種別をまたいだ往復でも保持される。
   */
  scrollPositions: Map<string, number>;
}

/**
 * サニタイズ済み DocumentFragment (renderMarkdownToFragment の戻り値) を描画するだけの
 * 表示コンポーネント。文字列注入系の DOM API は一切使わず、DOM ノードとして受け取った
 * フラグメントを container.replaceChildren() で差し替える。
 *
 * FilesTab は preview タブごとに新しいインスタンスを作らず、アクティブなタブが
 * preview のときにこの 1 個の要素を使い回す (key を振っていない) — そのため
 * 「path が変わった」= 別ファイルのプレビューに切り替わった、を自前で検知する必要がある
 * (外部画像トグルのリセットに使う)。
 */
export default function MarkdownPreview({
  root,
  path,
  source,
  error,
  tooLarge,
  binary,
  onRefresh,
  onOpenPreview,
  onOpenFile,
  scrollPositions,
}: MarkdownPreviewProps) {
  // 外部画像を読み込むかどうかはこのコンポーネントの state のみで持ち、永続化しない
  // (タブの寿命と揃える。既定は false — 起動直後・切替直後は一切の外部通信を発生させない)。
  const [allowExternalImages, setAllowExternalImages] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // path が変わった(=別のプレビュータブに切り替わった)ら外部画像許可をリセットする。
  // このコンポーネントは FilesTab 側で key を振られておらず全 preview タブで使い回される
  // ため、これをやらないと「ファイル A で許可 → ファイル B に切替」でも許可が生き残り、
  // ユーザーの明示操作なしに B の外部画像が読み込まれてしまう(既定 false の意図が崩れる)。
  // レンダー中に直接 state を更新する React 公式パターン
  // (https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes)
  // — useEffect 経由だと「リセット前の 1 フレーム」が挟まってしまう。
  const prevPathRef = useRef(path);
  if (prevPathRef.current !== path) {
    prevPathRef.current = path;
    if (allowExternalImages) setAllowExternalImages(false);
  }

  const showBody = !error && !binary && !tooLarge && source !== null;

  // R-1 (2026-07-27 レビュー指摘) その 2: 「読み込み成功時に error をクリアする」
  // (FilesTab.tsx 側の修正) だけだと、source が (エラー発生前と) 同一文字列のケースで
  // 下の useEffect (deps は [source, path, root, allowExternalImages]) が再実行されない
  // 一方、showBody は false→true に変わって .md-preview-body の div は「新しい DOM
  // ノードとして再マウント」される — 結果、空のままの div が残ってしまう。
  //
  // 「effect の deps が変わったら描き直す」という依存関係ベースの構造だけでは
  // 「body の DOM ノードそのものが張り直された」ケースを構造的に保証できない。
  // ref コールバックを使い、DOM ノードが実際に取り付けられた瞬間 (mount のたび、
  // effect の deps が変化したかどうかに関係なく) 必ず描き直すことで、この 2 経路
  // (「内容が変わった」「ノードが張り直された」) のどちらが起きても描画が保証される
  // 構造にする。
  const latestRef = useRef({ source, path, root, allowExternalImages });
  latestRef.current = { source, path, root, allowExternalImages };
  // 直前に描画した内容の署名。同じ内容を同じノードに対して二重に描画しない
  // (ref コールバックと effect の両方から呼ばれるため、素朴にやると同一コミット内で
  // 2 回描画されることがある)。ノードが新規 (子要素が空) なら署名が一致していても
  // 必ず描き直す — これが R-1 その 2 の本体。
  const lastRenderedSigRef = useRef<string | null>(null);

  const renderBody = useCallback((container: HTMLDivElement) => {
    const cur = latestRef.current;
    if (cur.source === null) return;
    const sig = JSON.stringify([cur.path, cur.root, cur.allowExternalImages, cur.source]);
    if (lastRenderedSigRef.current === sig && container.childNodes.length > 0) return;
    lastRenderedSigRef.current = sig;

    const fragment = renderMarkdownToFragment(cur.source, {
      mdPath: cur.path,
      root: cur.root,
      allowExternalImages: cur.allowExternalImages,
    });
    container.replaceChildren(fragment);
    // スクロール位置は「プレーンな内容が描画された直後」に復元する。ハイライトの
    // 完了を待たない(着色で高さが変わることは実質ない上、進行描画=先にプレーンが
    // 出て後から色が付く、という体験を優先する)。
    container.scrollTop = scrollPositions.get(cur.path) ?? 0;

    // コードブロックの着色 (T7)。render.ts が data-lang 属性を付けたものだけが対象
    // (info string が無いフェンスは data-lang 自体が無く、ここでも対象外 = プレーン表示)。
    // 各要素の書き込み可否は highlightInto 自身が el.isConnected で判定するので、
    // ここでは待たずに撃ちっぱなしでよい(進行描画: プレーンが即出て直後に着色される)。
    for (const codeEl of container.querySelectorAll<HTMLElement>('code[data-lang]')) {
      const lang = codeEl.dataset.lang ?? '';
      const code = codeEl.textContent ?? '';
      void highlightInto(codeEl, code, lang);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // 中身は常に latestRef 経由で最新値を読むので、identity を固定してよい

  // 通常の再描画トリガー (内容・トグルが変わった)。body の DOM ノード自体は
  // showBody が true の間ずっと同一なので、ここでは deps 変化時にだけ描き直す。
  useEffect(() => {
    if (bodyRef.current) renderBody(bodyRef.current);
  }, [source, path, root, allowExternalImages, renderBody]);

  // body の DOM ノードが (再) マウントされた瞬間に必ず描き直す ref コールバック。
  // identity を renderBody 同様固定することで、親の無関係な再レンダーのたびに
  // detach→attach が起きて毎回描き直されてしまう事態を避ける。
  const bodyRefCallback = useCallback(
    (node: HTMLDivElement | null) => {
      bodyRef.current = node;
      if (node) renderBody(node);
    },
    [renderBody],
  );

  const handleScroll = () => {
    scrollPositions.set(path, bodyRef.current?.scrollTop ?? 0);
  };

  // プレビューコンテナ 1 個に付ける delegated handler (リンク 1 個ずつには付けない)。
  // render.ts が出す <a> は例外なく href="#" なので、素通りさせるとブラウザーが
  // "#" へ遷移し SPA の catch-all が index.html を返してアプリごとリロードされる —
  // 見つかった <a> は種別に関わらず必ず preventDefault する。
  const handleClick = (e: MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const anchor = target.closest('a');
    if (!anchor || !e.currentTarget.contains(anchor)) return;
    e.preventDefault();

    const relPath = anchor.getAttribute('data-deck-link');
    if (relPath !== null) {
      if (isMarkdownPath(relPath)) onOpenPreview(relPath);
      else onOpenFile(relPath);
      return;
    }
    const url = anchor.getAttribute('data-deck-external');
    if (url !== null) {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
    // anchor (#foo) / blocked: data-deck-* が無いので何もしない (preventDefault 済み)。
  };

  return (
    <div className="md-preview">
      <div className="editor-toolbar">
        <span className="editor-path" title={path}>
          {path}
        </span>
        <button className="icon-btn" onClick={onRefresh} title="更新">
          <span className="codicon codicon-refresh" />
        </button>
        <button
          className={`icon-btn md-preview-toggle ${allowExternalImages ? 'active' : ''}`}
          onClick={() => setAllowExternalImages((v) => !v)}
          title="外部画像を読み込む"
        >
          <span className="codicon codicon-globe" />
        </button>
      </div>
      {error ? (
        <div className="placeholder">⚠ {error}</div>
      ) : binary ? (
        <div className="placeholder">バイナリファイルは表示できません</div>
      ) : tooLarge ? (
        <div className="placeholder">ファイルが大きすぎます</div>
      ) : source === null ? (
        <div className="placeholder">読み込み中...</div>
      ) : null}
      {showBody && (
        <div className="md-preview-body" ref={bodyRefCallback} onClick={handleClick} onScroll={handleScroll} />
      )}
    </div>
  );
}
