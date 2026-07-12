import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

export default function XTermTile({
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

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily: 'Consolas, "Cascadia Mono", Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: '#1b1b20',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
        selectionBackground: '#264f78',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);

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
        term.write('\r\n\x1b[90m[プロセスが終了しました]\x1b[0m\r\n');
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
      term.dispose();
    };
  }, [id]);

  useEffect(() => {
    if (visible) containerRef.current?.querySelector('textarea')?.focus();
  }, [visible]);

  return (
    <div
      ref={containerRef}
      className="xterm-container"
      style={{ display: visible ? 'block' : 'none' }}
    />
  );
}
