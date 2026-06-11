import { useState } from 'react';
import { api } from '../api';
import { useDeck } from '../store';
import type { Repo, Worktree } from '../types';
import StatusBadge from './StatusBadge';
import FilesTab from './FilesTab';
import GitTab from './GitTab';
import TerminalPanel from './TerminalPanel';

type Tab = 'files' | 'git';

export default function WorktreeView({ repo, worktree }: { repo: Repo; worktree: Worktree }) {
  const { refresh, setError } = useDeck();
  const [tab, setTab] = useState<Tab>('files');
  const [showTerminal, setShowTerminal] = useState(true);
  const [syncing, setSyncing] = useState<string | null>(null);

  const dirty =
    (worktree.status?.staged ?? 0) +
    (worktree.status?.unstaged ?? 0) +
    (worktree.status?.untracked ?? 0);

  const sync = async (kind: 'fetch' | 'pull' | 'push') => {
    setSyncing(kind);
    setError(null);
    try {
      if (kind === 'fetch') await api.fetch(worktree.path);
      else if (kind === 'pull') await api.pull(worktree.path);
      else await api.push(worktree.path);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(null);
    }
  };

  return (
    <div className="wt-view">
      <div className="wt-header">
        <div className="wt-header-info">
          <span className="wt-header-repo">{repo.name}</span>
          <span className="wt-header-branch">{worktree.branch ?? `(detached ${worktree.head})`}</span>
          <StatusBadge status={worktree.agent.status} />
          <span className="wt-sync">
            <button
              className="icon-btn"
              title="フェッチ (git fetch --all --prune)"
              disabled={syncing !== null}
              onClick={() => void sync('fetch')}
            >
              <span className={`codicon codicon-refresh ${syncing === 'fetch' ? 'spin' : ''}`} />
            </button>
            <button
              className="icon-btn"
              title={`プル${worktree.status?.behind ? ` (↓${worktree.status.behind})` : ''}`}
              disabled={syncing !== null}
              onClick={() => void sync('pull')}
            >
              <span className={`codicon codicon-arrow-down ${syncing === 'pull' ? 'spin' : ''}`} />
              {(worktree.status?.behind ?? 0) > 0 && (
                <span className="sync-count">{worktree.status?.behind}</span>
              )}
            </button>
            <button
              className="icon-btn"
              title={`プッシュ${worktree.status?.ahead ? ` (↑${worktree.status.ahead})` : ''}${worktree.status?.upstream ? '' : ' — upstream 未設定のため -u origin で公開'}`}
              disabled={syncing !== null}
              onClick={() => void sync('push')}
            >
              <span className={`codicon codicon-arrow-up ${syncing === 'push' ? 'spin' : ''}`} />
              {(worktree.status?.ahead ?? 0) > 0 && (
                <span className="sync-count">{worktree.status?.ahead}</span>
              )}
            </button>
          </span>
        </div>
        <div className="wt-tabs">
          <button className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>
            ファイル
          </button>
          <button className={tab === 'git' ? 'active' : ''} onClick={() => setTab('git')}>
            Git{dirty > 0 ? ` (${dirty})` : ''}
          </button>
          <button
            className={`terminal-toggle ${showTerminal ? 'active' : ''}`}
            onClick={() => setShowTerminal((v) => !v)}
            title="ターミナルパネルの表示/非表示"
          >
            ターミナル
          </button>
        </div>
      </div>
      <div className="wt-body">
        <div className="wt-content">
          {tab === 'files' && <FilesTab root={worktree.path} />}
          {tab === 'git' && <GitTab repo={repo} worktree={worktree} />}
        </div>
        {showTerminal && <TerminalPanel cwd={worktree.path} />}
      </div>
    </div>
  );
}
