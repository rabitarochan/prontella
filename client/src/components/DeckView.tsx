import { useDeck } from '../store';
import StatusBadge from './StatusBadge';

export default function DeckView() {
  const { repos, select } = useDeck();
  const cards = repos.flatMap((repo) =>
    repo.worktrees.map((wt) => ({ repo, wt })),
  );

  if (cards.length === 0) {
    return (
      <div className="placeholder">
        <h2>Claude Deck</h2>
        <p>左のサイドバーからリポジトリーを追加すると、Worktree とエージェントの状態が一覧表示されます。</p>
      </div>
    );
  }

  return (
    <div className="deck">
      <h2 className="deck-title">デッキ — 全 Worktree のエージェント状態</h2>
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
                  {s.ahead > 0 && <span title="ahead">↑{s.ahead}</span>}
                  {s.behind > 0 && <span title="behind">↓{s.behind}</span>}
                  {s.staged > 0 && <span className="stat-staged" title="ステージ済み">●{s.staged}</span>}
                  {s.unstaged > 0 && <span className="stat-unstaged" title="未ステージ">±{s.unstaged}</span>}
                  {s.untracked > 0 && <span className="stat-untracked" title="未追跡">?{s.untracked}</span>}
                  {s.conflicted > 0 && <span className="stat-conflict" title="コンフリクト">!{s.conflicted}</span>}
                  {s.ahead + s.behind + s.staged + s.unstaged + s.untracked + s.conflicted === 0 && (
                    <span className="stat-clean">clean</span>
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
