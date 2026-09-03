import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { WebglAddon } from '@xterm/addon-webgl';
import { t } from '../i18n';
import { createLatestThrottle } from '../lib/latestThrottle';
import { openLiveSocket, type LinkPhase } from '../lib/liveSocket';
import { BASE_FONT_SIZE } from '../lib/mirrorFont';
import { clearMirrorScale, refitMirror } from '../lib/mirrorFontDom';
import { usePageActivity, wirePageActivity } from '../lib/pageActivity';
import { useTheme } from '../theme/themeStore';
import { terminalTheme } from '../theme/terminalTheme';

/**
 * One xterm.js instance bound to a PTY session (/ws/term). Mounted once per
 * session and kept alive across tab switches — hide with `visible` instead of
 * unmounting, so scrollback and the WebSocket connection survive.
 *
 * The socket auto-reconnects (lib/liveSocket.ts). The server keeps the PTY
 * alive across socket loss and replays scrollback + tracked DEC modes on
 * reattach, so recovery only needs the client to come back.
 *
 * WebGL is loaded only while `visible && preferWebgl` is true. Each terminal's
 * WebGL addon owns its own GPU context, and a browser tab has a hard cap on
 * how many live WebGL contexts it can hold at once (~16 in Chrome, measured in
 * isolation); go over it and the oldest context is silently evicted, forever
 * demoting that terminal to the slow DOM renderer. Loading WebGL only for
 * the visible terminal(s) keeps the live-context count bounded by "one per
 * visible tile", which removes the ceiling problem structurally instead of
 * reacting to eviction after the fact. Pages that show many terminals at
 * once (the terminal monitor) pass `preferWebgl` for one tile only.
 *
 * PTY size (主張 / 追従): the PTY has a single winsize, shared by every page
 * that attaches to the session. Only the *active* page (visible + focused,
 * lib/pageActivity.ts) claims the size: it fits cols/rows to its container
 * and sends `resize`. An inactive page follows instead — it applies the size
 * the server broadcasts (`snapshot` / `resize` carry cols/rows), keeps that
 * grid, and only shrinks its font so the grid fits its box. When the page
 * becomes active again it fits and claims its own size back.
 */
/** PTY への resize 送信の最短間隔。ドラッグ中の追従感と再描画コストの折り合い (VS Code も同程度)。 */
const RESIZE_SEND_MS = 80;
/** 非表示中に保留する出力の上限。超えたら隠れたまま書き出す (表示時の一括処理を有界にする)。 */
const DEFER_MAX_BYTES = 1024 * 1024;

export default function XTermView({
  id,
  claudeMode,
  visible = true,
  preferWebgl = true,
  autoFocus = true,
}: {
  id: string;
  claudeMode: boolean;
  visible?: boolean;
  /** WebGL レンダラーを使ってよいか (visible との AND)。多数表示する画面は 1 枚だけ true にする。 */
  preferWebgl?: boolean;
  /** visible になったとき textarea へフォーカスを移すか。 */
  autoFocus?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<LinkPhase>('connecting');
  // 一瞬の再接続で毎回明滅する方が実害が大きいので、切断が続いたときだけ出す。
  const [showBadge, setShowBadge] = useState(false);
  const claudeModeRef = useRef(claudeMode);
  claudeModeRef.current = claudeMode;
  const termRef = useRef<Terminal | null>(null);
  const webglRef = useRef<WebglAddon | null>(null);
  // Set once construction/activation fails (no WebGL2 support) so later
  // visibility toggles don't keep retrying a load that can't succeed.
  const webglBrokenRef = useRef(false);
  const webglWanted = visible && preferWebgl;
  const webglWantedRef = useRef(webglWanted);
  webglWantedRef.current = webglWanted;

  wirePageActivity();
  const pageActive = usePageActivity((s) => s.active);
  const pageActiveRef = useRef(pageActive);
  pageActiveRef.current = pageActive;
  // アクティブへ遷移したときに自分の寸法を取り返すための入口 (mount effect が差す)。
  const claimRef = useRef<(() => void) | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  // 非表示中に保留した出力を書き出す入口 (mount effect が差す)。
  const flushDeferredRef = useRef<(() => void) | null>(null);

  // WebGL rendering is much faster than the default DOM renderer, but its
  // context is a scarce, capped resource (see the file-level comment) and it
  // can also be lost outright (GPU driver reset, tab discard). `syncWebgl`
  // brings the addon to whatever state `want` calls for; `disposeWebgl` does
  // the actual teardown and is the only place that clears `webglRef`.
  function syncWebgl(want: boolean) {
    const term = termRef.current;
    if (!term) return;
    if (want && !webglRef.current && !webglBrokenRef.current) {
      let webgl: WebglAddon | undefined;
      try {
        webgl = new WebglAddon();
        webgl.onContextLoss(() => disposeWebgl());
        term.loadAddon(webgl);
        webglRef.current = webgl;
      } catch {
        // WebGL unavailable, or activation failed partway through — release
        // whatever got partially set up (xterm's AddonManager guards against
        // a redundant dispose call, so this is safe even if nothing ran) and
        // keep the DOM renderer for the rest of this terminal's lifetime.
        try {
          webgl?.dispose();
        } catch {
          // already in a bad state — nothing more we can do
        }
        webglBrokenRef.current = true;
      }
    } else if (!want && webglRef.current) {
      disposeWebgl();
    }
  }

  // `el` lets the caller supply the container explicitly. On unmount, React
  // 18 detaches `containerRef.current` (sets it to null) during the mutation
  // phase, which runs *before* passive-effect cleanups — so by the time this
  // runs from the mount effect's cleanup, `containerRef.current` is already
  // null and would find no canvases (verified against React 18.3.1; the
  // StrictMode dev double-invoke masks this because its pseudo-unmount
  // doesn't actually detach the ref). The visibility-toggle and
  // onContextLoss callers still have a live ref, so they can omit it.
  function disposeWebgl(el?: HTMLElement) {
    const webgl = webglRef.current;
    if (!webgl) return;
    webglRef.current = null;
    // WebglAddon.dispose() switches xterm back to the DOM renderer and
    // removes its own <canvas> from the DOM, but it does NOT lose the WebGL
    // context — left alone, the context is only reclaimed by GC, which is
    // exactly the leak this whole change exists to close. So: grab the
    // canvas elements *before* dispose() (afterwards they're gone from the
    // DOM and querySelectorAll can no longer find them), then explicitly
    // lose the context once dispose() has run.
    const container = el ?? containerRef.current;
    const canvases = container ? Array.from(container.querySelectorAll('canvas')) : [];
    try {
      webgl.dispose();
    } catch {
      // e.g. already disposed via a context-loss callback — ignore
    }
    for (const canvas of canvases) {
      // `.xterm-screen` holds two canvases: xterm core's 2D link-layer
      // canvas and the addon's WebGL one. getContext('webgl2') on the 2D
      // canvas returns null (it already owns a 2d context), so only the
      // WebGL canvas is affected here. This scan assumes both canvases
      // already have a context bound (true today) — if a canvas with no
      // context yet ever reached this point, calling getContext('webgl2')
      // on it would *create* a new WebGL context rather than detect an
      // existing one, and this approach would need to be revisited.
      const gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    }
  }

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily: 'Consolas, "Cascadia Mono", Menlo, monospace',
      fontSize: BASE_FONT_SIZE,
      cursorBlink: true,
      scrollback: 5000,
      // テーマ変更はマウント後に options.theme の代入で追従する(下の effect)。
      // この生成 effect の依存に resolved を入れるとターミナルごと remount して
      // スクロールバックと WebSocket が失われるため、初期値は getState で読む。
      theme: terminalTheme(useTheme.getState().resolved),
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    // OSC 52 support — Claude Code's select-to-copy emits OSC 52; xterm core drops it without this addon.
    term.loadAddon(new ClipboardAddon());
    term.open(container);

    syncWebgl(webglWantedRef.current);

    // 追従側のフォント再フィット。連続するリサイズ / メッセージを 1 フレームに合流する。
    let refitRaf = 0;
    const scheduleRefit = () => {
      if (refitRaf) cancelAnimationFrame(refitRaf);
      refitRaf = requestAnimationFrame(() => {
        refitRaf = 0;
        if (container.offsetWidth > 0 && container.offsetHeight > 0) refitMirror(term, container);
      });
    };

    // 非表示 (display:none のタブ) の間は出力を xterm に流さず保留する。xterm は
    // 見えていなくてもパースと DOM レンダラーの行更新を続けるので、隠れタブが多い
    // ほど (モニターや分割タブ) 主スレッドを食う。表示に戻った瞬間にまとめて書く
    // (xterm の WriteBuffer は数 ms ずつ刻んで処理するので長いフレーム落ちにはならない)。
    // 保留量には上限を設け、超えたら隠れたまま書き出して表示時の一括処理を有界にする。
    let deferred: (string | Uint8Array)[] = [];
    let deferredBytes = 0;
    const flushDeferred = () => {
      if (deferred.length === 0) return;
      const items = deferred;
      deferred = [];
      deferredBytes = 0;
      for (const chunk of items) term.write(chunk);
    };
    const discardDeferred = () => {
      deferred = [];
      deferredBytes = 0;
    };
    const writeOrDefer = (chunk: string | Uint8Array) => {
      if (visibleRef.current) {
        term.write(chunk);
        return;
      }
      deferred.push(chunk);
      deferredBytes += chunk.length;
      if (deferredBytes > DEFER_MAX_BYTES) flushDeferred();
    };
    flushDeferredRef.current = flushDeferred;

    // 主張側: 通常フォントで枠に合わせて cols/rows を決め、PTY へ送る。
    // 非アクティブなページは PTY のサイズを主張しない (フォントだけ枠に合わせる)。
    // サーバーへの resize 送信は間引く: セパレーターのドラッグ中は ResizeObserver が
    // 毎フレーム発火し、そのたびに PTY をリサイズすると ConPTY と TUI が全画面を
    // 描き直してカクつく。ローカルの fit は即時 (格子は追従する) で、PTY へ届ける
    // 値だけ最新のものを RESIZE_SEND_MS ごとに 1 回にする。
    const resizeThrottle = createLatestThrottle<{ cols: number; rows: number }>(
      (size) => link.send({ type: 'resize', ...size }),
      RESIZE_SEND_MS,
    );
    // immediate = 再接続直後やアクティブ復帰など、待つと「サイズが追従しない」に見える場面。
    const sendResize = (immediate = false) => {
      if (!pageActiveRef.current) {
        scheduleRefit();
        return;
      }
      clearMirrorScale(term);
      if (term.options.fontSize !== BASE_FONT_SIZE) term.options.fontSize = BASE_FONT_SIZE;
      try {
        fit.fit();
      } catch {
        return;
      }
      resizeThrottle.push({ cols: term.cols, rows: term.rows });
      if (immediate) resizeThrottle.flush();
    };
    claimRef.current = () => sendResize(true);

    // 追従側: サーバーが配る実サイズに格子を合わせる (TUI の再描画出力が届く前に)。
    const applyRemoteSize = (msg: { cols?: unknown; rows?: unknown }) => {
      const { cols, rows } = msg;
      if (typeof cols !== 'number' || typeof rows !== 'number') return;
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return;
      // 保留中の出力は旧サイズで描かれたものなので、格子を変える前に流し切る
      flushDeferred();
      if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
      scheduleRefit();
    };

    // link の identity は再接続をまたいで不変なので、下の入力ハンドラーは
    // これを捕まえておけばよい (差し替わるのは内部の WebSocket だけ)。
    const link = openLiveSocket({
      path: `/ws/term?id=${id}`,
      onPhase: setPhase,
      // 再接続のたびに今のサイズを送り直す。これが無いと、繋ぎ直っても PTY の
      // winsize が切断前のままで「リサイズが追従しない」症状が残る。
      // (非アクティブなページでは送らず、直後の snapshot が運ぶ cols/rows に従う。)
      onOpen: () => sendResize(true),
      // PTY 出力はバイナリフレーム (server/pty.ts の flush)。xterm はバイト列を
      // 直接受けられ、JSON 文字列より速い経路になる。
      onBinary: writeOrDefer,
      onMessage: (raw) => {
        const msg = raw as { type?: string; data?: string; message?: string; cols?: unknown; rows?: unknown };
        if (msg.type === 'snapshot') {
          // 再アタッチ時はサーバーが追跡中の DEC モード (bracketed paste・
          // マウス) をプレフィックスに付けて送り直す (server/pty.ts の attach)。
          // snapshot は画面全体を作り直すので、保留中の出力は捨ててよい
          discardDeferred();
          if (!pageActiveRef.current) applyRemoteSize(msg);
          term.reset();
          term.write(msg.data ?? '');
        } else if (msg.type === 'data') {
          writeOrDefer(msg.data ?? '');
        } else if (msg.type === 'resize') {
          // 別のページが主張したサイズ。主張側 (アクティブ) は自分の fit が正なので無視する。
          if (!pageActiveRef.current) applyRemoteSize(msg);
        } else if (msg.type === 'exit') {
          flushDeferred();
          term.write(`\r\n\x1b[90m${t('term.processExited')}\x1b[0m\r\n`);
          // プロセスが終わればサーバーはセッションを破棄する。繋ぎ直しても
          // 「見つかりません」を取りに行くだけなので、ここで打ち切る。
          link.stop('gone');
        } else if (msg.type === 'error') {
          flushDeferred();
          term.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`);
          link.stop('gone');
        }
      },
    });

    // Claude Code submits on plain Enter (\r). Translate Shift+Enter to
    // Meta+Enter (ESC CR), which Claude Code treats as "insert newline".
    // Only while Claude is detected — in a plain shell ESC would clear the line.
    // The handler fires for keydown AND keypress — both must return false,
    // but the translated sequence is sent only once (on keydown).
    term.attachCustomKeyEventHandler((e) => {
      if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && claudeModeRef.current) {
        if (e.type === 'keydown') link.send({ type: 'input', data: '\x1b\r' });
        return false;
      }
      return true;
    });

    const dataDisposable = term.onData((data) => {
      link.send({ type: 'input', data });
    });

    const observer = new ResizeObserver(() => {
      if (container.offsetWidth > 0 && container.offsetHeight > 0) sendResize();
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      if (refitRaf) cancelAnimationFrame(refitRaf);
      resizeThrottle.cancel();
      claimRef.current = null;
      flushDeferredRef.current = null;
      discardDeferred();
      dataDisposable.dispose();
      link.stop();
      // Pass the effect-local `container` explicitly — on unmount,
      // containerRef.current is already null by the time this cleanup runs
      // (see the comment on disposeWebgl).
      disposeWebgl(container);
      term.dispose();
      termRef.current = null;
    };
  }, [id]);

  useEffect(() => {
    syncWebgl(webglWanted);
  }, [webglWanted]);

  useEffect(() => {
    if (!visible) return;
    // 表示に戻った: 非表示中に保留した出力を書き出す (ResizeObserver の refit より先)
    flushDeferredRef.current?.();
    if (autoFocus) containerRef.current?.querySelector('textarea')?.focus();
  }, [visible, autoFocus]);

  // ページがアクティブになったら自分の寸法を取り返す (枠が可視のときだけ。
  // display:none 中のターミナルは visible 切替時の ResizeObserver が拾う)。
  useEffect(() => {
    if (!pageActive) return;
    const container = containerRef.current;
    if (container && container.offsetWidth > 0 && container.offsetHeight > 0) claimRef.current?.();
  }, [pageActive]);

  // 復帰したら即座に消し、落ちたときだけ 1 秒待ってから出す。
  useEffect(() => {
    if (phase === 'open') {
      setShowBadge(false);
      return;
    }
    if (phase === 'gone') {
      setShowBadge(true);
      return;
    }
    const timer = setTimeout(() => setShowBadge(true), 1_000);
    return () => clearTimeout(timer);
  }, [phase]);

  // テーマ切り替えは options.theme の実行時代入で即再描画される。
  // インスタンスは保持されるためスクロールバックも WebSocket も無傷。
  const resolvedTheme = useTheme((s) => s.resolved);
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = terminalTheme(resolvedTheme);
  }, [resolvedTheme]);

  return (
    // xterm は自分の DOM を container の中に append するため、React の子要素
    // (バッジ) は同じ親に混ぜず 1 枚外側のラッパーに置く。
    <div className="xterm-host" style={{ display: visible ? 'block' : 'none' }}>
      <div ref={containerRef} className="xterm-container" />
      {showBadge && (
        <div className={`term-conn-badge${phase === 'gone' ? ' is-gone' : ''}`}>
          {t(phase === 'gone' ? 'term.sessionLost' : 'term.reconnecting')}
        </div>
      )}
    </div>
  );
}
