// VS Code タイルの iframe 実体。React ツリーの外にモジュールレベルで 1 つだけ持つ。
//
// **この方式を採る理由 — iframe は他のパネルと性質が違う**
//
// Monaco / xterm / React のパネルは DOM を移動されても状態が残るので、TileGrid の
// host + createPortal パターン (TileGrid.tsx) で足りている。しかし iframe は
// DOM から外して入れ直した時点で中身が丸ごと再ロードされる。そして prontella には
// それを起こす経路が 2 つある:
//   - TilePane.adoptHost の `el.appendChild(host)` (分割・クローズ・DnD で host が動く)
//   - App.tsx の `<WorktreeView key={worktree.path}>` (ワークツリー切替でタイル木ごと remount)
// 素直にタイルの中に置くと、そのたびに実行中のデバッグセッションが飛ぶ。
//
// そこで iframe は <main> 直下 (VncView と同じ層 = key remount の外) に一度だけ挿し、
// **以後 DOM 上を一切動かさない**。タイル側には空のプレースホルダーだけを描き、
// その矩形に position:fixed で追従させる。VncView が
// 「display:none 保持が RFB 接続の生存条件」として App 直下に置かれているのと同じ判断。
//
// 不変条件: **生成した iframe を再 parent しない。** 位置合わせは常に座標で行う。

/** ワークツリーごとに iframe を持てる形にしておく (段階 6 で使う。今は 1 本だけ入る)。 */
const frames = new Map<string, HTMLIFrameElement>();
let container: HTMLDivElement | null = null;
/** 現在オーバーレイを占有しているプレースホルダー。null なら非表示。 */
let owner: { key: string; el: HTMLElement } | null = null;
/**
 * 占有タイルが表示中か。**矩形が 0 かどうかから推測しない。**
 * パネル自身が visible を知っているので、それを直接の真理値として持つ
 * (推測に頼ると、測るきっかけを 1 つ落としただけで iframe が他ビューに
 * 被さったまま残る — 実際にそれを踏んだ)。
 */
let visible = false;
let observer: ResizeObserver | null = null;
let rafId = 0;

function ensureContainer(): HTMLDivElement {
  if (container) return container;
  const el = document.createElement('div');
  el.className = 'vscode-overlay';
  el.hidden = true;
  document.body.appendChild(el);
  container = el;
  window.addEventListener('resize', scheduleSync);
  // スプリッターのドラッグやサイドバー開閉など、ResizeObserver に出ない
  // レイアウト変化も拾うためスクロール/遷移をまとめて監視する
  window.addEventListener('scroll', scheduleSync, true);
  return el;
}

function ensureFrame(key: string, src: string): HTMLIFrameElement {
  let frame = frames.get(key);
  if (frame) return frame;
  frame = document.createElement('iframe');
  frame.className = 'vscode-overlay-frame';
  frame.src = src;
  // クリップボードとフルスクリーンは workbench が使う
  frame.allow = 'clipboard-read; clipboard-write; fullscreen';
  ensureContainer().appendChild(frame);
  frames.set(key, frame);
  return frame;
}

/**
 * resize / scroll / ResizeObserver のような連続発火を rAF でまとめる。
 * **表示状態の反映にはこの経路を使わない** — rAF はタブが背面に回ったり
 * レンダラーが詰まると走らず、rafId が立ったまま以後すべて no-op になる。
 * 離散的なきっかけ (attach / 表示切替 / レイアウト変更) は必ず同期で反映する。
 */
function scheduleSync(): void {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    syncRect();
  });
}

/** プレースホルダーの矩形にオーバーレイを合わせる。同期実行して構わない軽さ。 */
function syncRect(): void {
  const el = container;
  if (!el) return;
  if (!owner || !visible) {
    el.hidden = true;
    return;
  }
  const r = owner.el.getBoundingClientRect();
  // 念のための二重防御。visible が真でも、タイルが畳まれていれば 0 になる
  if (r.width === 0 || r.height === 0) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.style.left = `${r.left}px`;
  el.style.top = `${r.top}px`;
  el.style.width = `${r.width}px`;
  el.style.height = `${r.height}px`;
}

/**
 * プレースホルダーを占有者にする。同じ key の iframe が既にあれば再利用し、
 * **src を張り替えない** (張り替えると再ロードされる)。
 */
export function attachOverlay(key: string, src: string, el: HTMLElement): void {
  ensureFrame(key, src);
  // 1 本しか iframe を持たない段階では、占有していないタイルの分は隠す
  for (const [k, f] of frames) f.hidden = k !== key;
  owner = { key, el };
  observer?.disconnect();
  observer = new ResizeObserver(scheduleSync);
  observer.observe(el);
  syncRect();
}

/** 占有を解除する。iframe は破棄しない (状態を保つため)。 */
export function detachOverlay(el: HTMLElement): void {
  if (owner?.el !== el) return;
  owner = null;
  visible = false;
  observer?.disconnect();
  observer = null;
  if (container) container.hidden = true;
}

/**
 * 占有タイルの表示状態を反映する。ビュー切替のたびに呼ぶこと。
 * 同期で反映する — rAF に載せると、走らなかったときに
 * iframe が他ビューの上に残る。
 */
export function setOverlayVisible(el: HTMLElement, next: boolean): void {
  if (owner?.el !== el) return;
  visible = next;
  syncRect();
}

/** レイアウトが動いたことを外から知らせる (スプリッターのドラッグ、タイル DnD 等)。 */
export function syncOverlay(): void {
  syncRect();
}

/**
 * ドラッグ中など、ポインターを iframe に吸わせたくない間だけ無効化する。
 * iframe はポインターイベントを飲むので、これがないとタイル DnD が壊れる。
 */
export function setOverlayInert(inert: boolean): void {
  ensureContainer().style.pointerEvents = inert ? 'none' : '';
}

/** 現在の占有キー (テスト・診断用)。 */
export function overlayOwnerKey(): string | null {
  return owner?.key ?? null;
}
