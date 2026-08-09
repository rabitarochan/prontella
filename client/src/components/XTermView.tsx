import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { WebglAddon } from '@xterm/addon-webgl';
import { t } from '../i18n';
import { useTheme } from '../theme/themeStore';
import { terminalTheme } from '../theme/terminalTheme';

/**
 * One xterm.js instance bound to a PTY session (/ws/term). Mounted once per
 * session and kept alive across tab switches — hide with `visible` instead of
 * unmounting, so scrollback and the WebSocket connection survive.
 *
 * WebGL is loaded only while `visible` is true. Each terminal's WebGL addon
 * owns its own GPU context, and a browser tab has a hard cap on how many
 * live WebGL contexts it can hold at once (~16 in Chrome, measured in
 * isolation); go over it and the oldest context is silently evicted, forever
 * demoting that terminal to the slow DOM renderer. Loading WebGL only for
 * the visible terminal(s) keeps the live-context count bounded by "one per
 * visible tile", which removes the ceiling problem structurally instead of
 * reacting to eviction after the fact.
 */
export default function XTermView({
  id,
  claudeMode,
  visible = true,
}: {
  id: string;
  claudeMode: boolean;
  visible?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const claudeModeRef = useRef(claudeMode);
  claudeModeRef.current = claudeMode;
  const termRef = useRef<Terminal | null>(null);
  const webglRef = useRef<WebglAddon | null>(null);
  // Set once construction/activation fails (no WebGL2 support) so later
  // visibility toggles don't keep retrying a load that can't succeed.
  const webglBrokenRef = useRef(false);

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
      fontSize: 13,
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

    syncWebgl(visible);

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/term?id=${id}`);

    const sendResize = () => {
      try {
        fit.fit();
      } catch {
        return;
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };

    ws.onopen = sendResize;
    ws.onmessage = (event) => {
      let msg: { type: string; data?: string; message?: string };
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.type === 'snapshot') {
        term.reset();
        term.write(msg.data ?? '');
      } else if (msg.type === 'data') {
        term.write(msg.data ?? '');
      } else if (msg.type === 'exit') {
        term.write(`\r\n\x1b[90m${t('term.processExited')}\x1b[0m\r\n`);
      } else if (msg.type === 'error') {
        term.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`);
      }
    };

    // Claude Code submits on plain Enter (\r). Translate Shift+Enter to
    // Meta+Enter (ESC CR), which Claude Code treats as "insert newline".
    // Only while Claude is detected — in a plain shell ESC would clear the line.
    // The handler fires for keydown AND keypress — both must return false,
    // but the translated sequence is sent only once (on keydown).
    term.attachCustomKeyEventHandler((e) => {
      if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && claudeModeRef.current) {
        if (e.type === 'keydown' && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data: '\x1b\r' }));
        }
        return false;
      }
      return true;
    });

    const dataDisposable = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    const observer = new ResizeObserver(() => {
      if (container.offsetWidth > 0 && container.offsetHeight > 0) sendResize();
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      dataDisposable.dispose();
      ws.close();
      // Pass the effect-local `container` explicitly — on unmount,
      // containerRef.current is already null by the time this cleanup runs
      // (see the comment on disposeWebgl).
      disposeWebgl(container);
      term.dispose();
      termRef.current = null;
    };
  }, [id]);

  useEffect(() => {
    syncWebgl(visible);
    if (visible) containerRef.current?.querySelector('textarea')?.focus();
  }, [visible]);

  // テーマ切り替えは options.theme の実行時代入で即再描画される。
  // インスタンスは保持されるためスクロールバックも WebSocket も無傷。
  const resolvedTheme = useTheme((s) => s.resolved);
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = terminalTheme(resolvedTheme);
  }, [resolvedTheme]);

  return (
    <div
      ref={containerRef}
      className="xterm-container"
      style={{ display: visible ? 'block' : 'none' }}
    />
  );
}
