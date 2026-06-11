import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { api } from '../api';
import { useDeck } from '../store';
import type { AgentStatus, TerminalSession } from '../types';
import StatusBadge from './StatusBadge';

const POLL_MS = 3000;

function XTermView({
  id,
  visible,
  claudeMode,
}: {
  id: string;
  visible: boolean;
  claudeMode: boolean;
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

export default function TerminalPanel({ cwd }: { cwd: string }) {
  const refreshDeck = useDeck((s) => s.refresh);
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  const load = useCallback(async () => {
    try {
      const list = await api.terminals(cwd);
      setSessions(list);
      const current = activeIdRef.current;
      if (list.length > 0 && (current === null || !list.some((s) => s.id === current))) {
        setActiveId(list[0].id);
      } else if (list.length === 0 && current !== null) {
        setActiveId(null);
      }
    } catch {
      // server restart etc. — next poll will recover
    }
  }, [cwd]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const create = async (run?: string) => {
    setCreating(true);
    try {
      const session = await api.createTerminal(cwd, run);
      await load();
      setActiveId(session.id);
      await refreshDeck();
    } finally {
      setCreating(false);
    }
  };

  const kill = async (id: string) => {
    if (!confirm('このターミナルを終了しますか?')) return;
    await api.killTerminal(id);
    await load();
    await refreshDeck();
  };

  const statusIcon = (status: AgentStatus) =>
    status === 'busy' ? '●' : status === 'waiting' ? '◐' : '○';

  return (
    <div className="terminal-panel">
      <div className="terminal-tabs">
        {sessions.map((session) => (
          <div
            key={session.id}
            className={`terminal-tab status-${session.status} ${activeId === session.id ? 'active' : ''}`}
            onClick={() => setActiveId(session.id)}
          >
            <span className="terminal-tab-icon">{statusIcon(session.status)}</span>
            {session.title}
            <button
              className="icon-btn"
              title="ターミナルを終了"
              onClick={(e) => {
                e.stopPropagation();
                void kill(session.id);
              }}
            >
              ✕
            </button>
          </div>
        ))}
        <button className="terminal-new" disabled={creating} onClick={() => void create()}>
          ＋ シェル
        </button>
        <button
          className="terminal-new claude"
          disabled={creating}
          onClick={() => void create('claude')}
          title="このWorktreeでClaude Codeを起動"
        >
          ✦ Claude 起動
        </button>
        {activeId && (
          <span className="terminal-status">
            <StatusBadge status={sessions.find((s) => s.id === activeId)?.status ?? 'none'} />
          </span>
        )}
      </div>
      <div className="terminal-body">
        {sessions.length === 0 ? (
          <div className="placeholder terminal-placeholder">
            「✦ Claude 起動」でこの Worktree のターミナル上に Claude Code を起動します
          </div>
        ) : (
          sessions.map((session) => (
            <XTermView
              key={session.id}
              id={session.id}
              visible={activeId === session.id}
              claudeMode={session.claudeDetected}
            />
          ))
        )}
      </div>
    </div>
  );
}
