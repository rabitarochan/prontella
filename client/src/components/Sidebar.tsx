import { useState } from 'react';
import { api } from '../api';
import { useDeck } from '../store';
import type { Repo } from '../types';
import StatusBadge from './StatusBadge';
import AddWorktreeModal from './AddWorktreeModal';

export default function Sidebar() {
  const { repos, selected, select, refresh, setError } = useDeck();
  const [worktreeTarget, setWorktreeTarget] = useState<Repo | null>(null);

  const addRepo = async () => {
    const path = prompt('Git リポジトリーのパスを入力してください:');
    if (!path) return;
    try {
      await api.addRepo(path.trim());
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const removeRepo = async (repo: Repo) => {
    if (!confirm(`${repo.name} を Deck から削除しますか?\n(リポジトリー自体は削除されません)`)) return;
    await api.removeRepo(repo.id);
    if (selected?.repoId === repo.id) select(null);
    await refresh();
  };

  const removeWorktree = async (repo: Repo, path: string) => {
    if (!confirm(`Worktree を削除しますか?\n${path}\n\n※ ディレクトリーごと削除されます`)) return;
    try {
      await api.removeWorktree(repo.id, path, false);
      if (selected?.worktreePath === path) select(null);
      await refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (confirm(`削除に失敗しました:\n${message}\n\n未コミットの変更ごと強制削除しますか?`)) {
        await api.removeWorktree(repo.id, path, true).catch((err: Error) => setError(err.message));
        await refresh();
      }
    }
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span>リポジトリー</span>
        <button className="icon-btn" onClick={() => void addRepo()} title="リポジトリーを追加">
          ＋
        </button>
      </div>
      <div className="sidebar-list">
        {repos.length === 0 && (
          <div className="sidebar-empty">
            ＋ ボタンから
            <br />
            リポジトリーを追加してください
          </div>
        )}
        {repos.map((repo) => (
          <div key={repo.id} className="repo-group">
            <div className="repo-row">
              <span className="repo-name" title={repo.path}>
                {repo.name}
              </span>
              <span className="repo-actions">
                <button
                  className="icon-btn"
                  title="Worktree を追加"
                  onClick={() => setWorktreeTarget(repo)}
                >
                  ＋
                </button>
                <button className="icon-btn" title="Deck から削除" onClick={() => void removeRepo(repo)}>
                  ✕
                </button>
              </span>
            </div>
            {repo.error && <div className="repo-error">⚠ {repo.error}</div>}
            {repo.worktrees.map((wt) => {
              const active = selected?.worktreePath === wt.path;
              const dirty =
                (wt.status?.staged ?? 0) + (wt.status?.unstaged ?? 0) + (wt.status?.untracked ?? 0);
              return (
                <div
                  key={wt.path}
                  className={`wt-row ${active ? 'active' : ''}`}
                  onClick={() => select({ repoId: repo.id, worktreePath: wt.path })}
                  title={wt.path}
                >
                  <StatusBadge status={wt.agent.status} compact />
                  <span className="wt-branch">
                    {wt.branch ?? `(detached ${wt.head})`}
                    {wt.isMain && <span className="wt-main-mark"> ●main</span>}
                  </span>
                  {dirty > 0 && <span className="wt-dirty">{dirty}</span>}
                  {!wt.isMain && (
                    <button
                      className="icon-btn wt-remove"
                      title="Worktree を削除"
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeWorktree(repo, wt.path);
                      }}
                    >
                      ✕
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {worktreeTarget && (
        <AddWorktreeModal repo={worktreeTarget} onClose={() => setWorktreeTarget(null)} />
      )}
    </aside>
  );
}
