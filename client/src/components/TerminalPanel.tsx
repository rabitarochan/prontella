import { useEffect, useState } from 'react';
import { useTerminalSessions } from '../layout/useTerminalSessions';
import type { AgentStatus } from '../types';
import StatusBadge from './StatusBadge';
import XTermTile from './tiles/XTermTile';

export default function TerminalPanel({ cwd }: { cwd: string }) {
  const { sessions: polled, create, kill } = useTerminalSessions(cwd);
  const sessions = polled ?? [];
  const [activeId, setActiveId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (polled === null) return;
    if (polled.length > 0 && (activeId === null || !polled.some((s) => s.id === activeId))) {
      setActiveId(polled[0].id);
    } else if (polled.length === 0 && activeId !== null) {
      setActiveId(null);
    }
  }, [polled, activeId]);

  const createSession = async (run?: string) => {
    setCreating(true);
    try {
      const session = await create(run);
      setActiveId(session.id);
    } finally {
      setCreating(false);
    }
  };

  const killSession = async (id: string) => {
    if (!confirm('このターミナルを終了しますか?')) return;
    await kill(id);
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
                void killSession(session.id);
              }}
            >
              ✕
            </button>
          </div>
        ))}
        <button className="terminal-new" disabled={creating} onClick={() => void createSession()}>
          ＋ シェル
        </button>
        <button
          className="terminal-new claude"
          disabled={creating}
          onClick={() => void createSession('claude')}
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
            <XTermTile
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
