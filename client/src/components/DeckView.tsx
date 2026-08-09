import { useEffect, useMemo, useState } from 'react';
import { findWorktree, resolveAndSelect, useAgentEvents, waitingSessions } from '../agentEvents';
import { isActive, isArchived } from '../repoSections';
import { useDeck } from '../store';
import type { TerminalSession } from '../types';
import StatusBadge from './StatusBadge';

function elapsed(since: number, now: number): string {
  const s = Math.max(0, Math.floor((now - since) / 1000));
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分`;
  return `${Math.floor(m / 60)}時間${m % 60}分`;
}

function sessionLabel(session: TerminalSession): { title: string; sub: string } {
  const hit = findWorktree(session.cwd);
  if (hit) return { title: `${hit.repo.name} / ${hit.worktree.branch ?? '(detached)'}`, sub: session.cwd };
  return { title: session.cwd.split(/[\\/]/).pop() || session.cwd, sub: session.cwd };
}

/**
 * デッキ = 管制塔: 上段に「あなたの確認を待っています」ヒーロー (経過タイマー付き、
 * クリックで該当 worktree へ直行)、下段に全 worktree のカードグリッド。
 */
export default function DeckView() {
  const { repos, select } = useDeck();
  const sessions = useAgentEvents((s) => s.sessions);
  const waiting = useMemo(() => waitingSessions(sessions), [sessions]);
  const [now, setNow] = useState(() => Date.now());
  // AttentionBell と同じ 10 秒 tick。確認待ちが無い間は止める
  useEffect(() => {
    if (waiting.length === 0) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, [waiting.length]);
  // ベルの D5 と同じ理由でグローバルエラーバーは使わない (4 秒ポーリング成功で消えるため)
  const [locateError, setLocateError] = useState<string | null>(null);

  const pick = async (session: TerminalSession) => {
    const ok = await resolveAndSelect(session.cwd);
    if (ok) setLocateError(null);
    else setLocateError(`このセッションの worktree を特定できません: ${session.cwd}`);
  };

  const cards = repos.filter(isActive).flatMap((repo) =>
    repo.worktrees.map((wt) => ({ repo, wt })),
  );

  if (cards.length === 0) {
    const archivedCount = repos.filter(isArchived).length;
    return (
      <div className="placeholder">
        <h2>Claude Deck</h2>
        {archivedCount > 0 ? (
          <p>表示できる worktree がありません(アーカイブ済み {archivedCount} 件)</p>
        ) : (
          <p>左のサイドバーからリポジトリーを追加すると、Worktree とエージェントの状態が一覧表示されます。</p>
        )}
      </div>
    );
  }

  return (
    <div className="deck">
      {waiting.length > 0 && (
        <section className="deck-hero">
          <div className="deck-hero-title">
            <span className="deck-hero-dot" />
            あなたの確認を待っています ({waiting.length})
          </div>
          {locateError && <div className="deck-hero-error">⚠ {locateError}</div>}
          <div className="deck-hero-grid">
            {waiting.map((s) => {
              const { title, sub } = sessionLabel(s);
              return (
                <button key={s.id} className="deck-hero-card" onClick={() => void pick(s)}>
                  <span className="deck-hero-card-label" title={sub}>
                    {title}
                  </span>
                  <span className="deck-hero-card-time">{elapsed(s.statusSince, now)}</span>
                  <span className="deck-hero-card-hint">クリックで確認へ →</span>
                </button>
              );
            })}
          </div>
        </section>
      )}
      <h2 className="deck-title">全 Worktree のエージェント状態</h2>
      <div className="deck-grid">
        {cards.map(({ repo, wt }) => {
          const s = wt.status;
          return (
            <div
              key={wt.path}
              className={`card card-${wt.agent.status}`}
              onClick={() => select({ repoId: repo.id, worktreePath: wt.path })}
            >
              <div className="card-head">
                <span className="card-repo">{repo.name}</span>
                <StatusBadge status={wt.agent.status} />
              </div>
              <div className="card-branch">
                {repo.gitMode === 'none' ? '(Git なし)' : (wt.branch ?? `(detached ${wt.head})`)}
                {repo.gitMode === 'root' && wt.isMain && <span className="wt-main-mark"> ●main</span>}
              </div>
              <div className="card-path" title={wt.path}>
                {wt.path}
              </div>
              {s && (
                <div className="card-stats">
                  {s.ahead > 0 && <span className="stat-chip" title="ahead">↑{s.ahead}</span>}
                  {s.behind > 0 && <span className="stat-chip" title="behind">↓{s.behind}</span>}
                  {s.staged > 0 && <span className="stat-chip stat-staged" title="ステージ済み">●{s.staged}</span>}
                  {s.unstaged > 0 && <span className="stat-chip stat-unstaged" title="未ステージ">±{s.unstaged}</span>}
                  {s.untracked > 0 && <span className="stat-chip stat-untracked" title="未追跡">?{s.untracked}</span>}
                  {s.conflicted > 0 && <span className="stat-chip stat-conflict" title="コンフリクト">!{s.conflicted}</span>}
                  {s.ahead + s.behind + s.staged + s.unstaged + s.untracked + s.conflicted === 0 && (
                    <span className="stat-chip stat-clean">clean</span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
