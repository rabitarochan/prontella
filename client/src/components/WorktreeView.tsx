import { useState } from 'react';
import { api } from '../api';
import { useDeck } from '../store';
import type { Repo, Worktree } from '../types';
import { leaves } from '../layout/tileTree';
import { useTerminalSessions } from '../layout/useTerminalSessions';
import { useTileLayout } from '../layout/useTileLayout';
import StatusBadge from './StatusBadge';
import TileGrid from './tiles/TileGrid';

export default function WorktreeView({ repo, worktree }: { repo: Repo; worktree: Worktree }) {
  const { refresh, setError } = useDeck();
  const [syncing, setSyncing] = useState<string | null>(null);
  const { sessions, create, kill } = useTerminalSessions(worktree.path);
  const tiles = useTileLayout(worktree.path, sessions, create, kill);

  const dirty =
    (worktree.status?.staged ?? 0) +
    (worktree.status?.unstaged ?? 0) +
    (worktree.status?.untracked ?? 0);

  const allLeaves = leaves(tiles.layout.root);
  const hasFiles = allLeaves.some((l) => l.content.kind === 'files');
  const hasGit = allLeaves.some((l) => l.content.kind === 'git');

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
          <button
            className={hasFiles ? 'active' : ''}
            title="ファイルタイルを開く/フォーカス"
            onClick={() => tiles.openContent('files')}
          >
            ファイル
          </button>
          <button
            className={hasGit ? 'active' : ''}
            title="Git タイルを開く/フォーカス"
            onClick={() => tiles.openContent('git')}
          >
            Git{dirty > 0 ? ` (${dirty})` : ''}
          </button>
          <button
            className="terminal-toggle"
            title="新しいシェルのタイルを開く"
            onClick={() => void tiles.openTerminal()}
          >
            ＋ シェル
          </button>
          <button
            className="claude-launch"
            title="このWorktreeでClaude Codeを起動"
            onClick={() => void tiles.openTerminal('claude')}
          >
            ✦ Claude 起動
          </button>
          <button
            className="icon-btn layout-reset"
            title="レイアウトを初期化"
            onClick={() => {
              if (confirm('レイアウトを初期化しますか?(未保存の編集内容は失われます)')) {
                tiles.reset();
              }
            }}
          >
            <span className="codicon codicon-layout" />
          </button>
        </div>
      </div>
      <div className="wt-body">
        <TileGrid repo={repo} worktree={worktree} sessions={sessions} actions={tiles} />
      </div>
    </div>
  );
}
