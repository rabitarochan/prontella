import { useEffect, useMemo, useState } from 'react';
import { findWorktree, useAgentEvents, waitingSessions } from '../agentEvents';
import { notificationPermission, requestNotificationPermission } from '../notify';
import { useDeck } from '../store';
import type { TerminalSession } from '../types';

function elapsed(since: number, now: number): string {
  const s = Math.max(0, Math.floor((now - since) / 1000));
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分`;
  return `${Math.floor(m / 60)}時間${m % 60}分`;
}

function itemLabel(session: TerminalSession): string {
  const hit = findWorktree(session.cwd);
  if (hit) return `${hit.repo.name} / ${hit.worktree.branch ?? '(detached)'}`;
  return session.cwd.split(/[\\/]/).pop() || session.cwd;
}

/** トップバーのベル: 要対応キュー (確認待ち/待機中の一覧) と通知設定。 */
export default function AttentionBell() {
  const sessions = useAgentEvents((s) => s.sessions);
  const desktopEnabled = useAgentEvents((s) => s.desktopEnabled);
  const soundEnabled = useAgentEvents((s) => s.soundEnabled);
  const setDesktopEnabled = useAgentEvents((s) => s.setDesktopEnabled);
  const setSoundEnabled = useAgentEvents((s) => s.setSoundEnabled);
  const select = useDeck((s) => s.select);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [permission, setPermission] = useState(notificationPermission());

  const waiting = useMemo(() => waitingSessions(sessions), [sessions]);
  const idleAgents = useMemo(
    () =>
      Object.values(sessions)
        .filter((s) => s.status === 'idle' && s.claudeDetected)
        .sort((a, b) => b.statusSince - a.statusSince),
    [sessions],
  );

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, [open]);

  const pick = (session: TerminalSession) => {
    const hit = findWorktree(session.cwd);
    if (hit) select({ repoId: hit.repo.id, worktreePath: hit.worktree.path });
    setOpen(false);
  };

  const toggleDesktop = async (checked: boolean) => {
    if (!checked) {
      setDesktopEnabled(false);
      return;
    }
    const granted = await requestNotificationPermission();
    setPermission(notificationPermission());
    setDesktopEnabled(granted);
  };

  const renderItem = (session: TerminalSession, dotCls: string) => (
    <button key={session.id} className="bell-item" onClick={() => pick(session)}>
      <span className={`bell-dot ${dotCls}`} />
      <span className="bell-item-label" title={session.cwd}>
        {itemLabel(session)}
      </span>
      <span className="bell-item-time">{elapsed(session.statusSince, now)}</span>
    </button>
  );

  return (
    <div className="bell">
      <button
        className={`icon-btn bell-btn ${waiting.length > 0 ? 'bell-alert' : ''}`}
        title={waiting.length > 0 ? `確認待ち ${waiting.length} 件` : '要対応キュー'}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`codicon ${waiting.length > 0 ? 'codicon-bell-dot' : 'codicon-bell'}`} />
        {waiting.length > 0 && <span className="bell-count">{waiting.length}</span>}
      </button>
      {open && (
        <>
          <div className="bell-overlay" onClick={() => setOpen(false)} />
          <div className="bell-panel">
            <div className="bell-section-title">確認待ち{waiting.length > 0 && ` (${waiting.length})`}</div>
            {waiting.length === 0 ? (
              <div className="bell-empty">対応が必要なエージェントはありません</div>
            ) : (
              waiting.map((s) => renderItem(s, 'bell-dot-waiting'))
            )}
            {idleAgents.length > 0 && (
              <>
                <div className="bell-section-title">待機中のエージェント ({idleAgents.length})</div>
                {idleAgents.map((s) => renderItem(s, 'bell-dot-idle'))}
              </>
            )}
            <div className="bell-prefs">
              <label>
                <input
                  type="checkbox"
                  checked={desktopEnabled && permission === 'granted'}
                  disabled={permission === 'denied' || permission === 'unsupported'}
                  onChange={(e) => void toggleDesktop(e.target.checked)}
                />
                デスクトップ通知
              </label>
              {permission === 'denied' && (
                <span className="bell-note">ブラウザ設定で通知がブロックされています</span>
              )}
              <label>
                <input
                  type="checkbox"
                  checked={soundEnabled}
                  onChange={(e) => setSoundEnabled(e.target.checked)}
                />
                サウンド
              </label>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
