import { useState } from 'react';
import { api } from '../api';
import { useDeck } from '../store';
import type { Repo, Worktree } from '../types';
import { useTerminalSessions } from '../layout/useTerminalSessions';
import { useTileLayout } from '../layout/useTileLayout';
import StatusBadge from './StatusBadge';
import TileGrid from './tiles/TileGrid';

/**
 * Worktree のメインビュー: 分割・リサイズできるタイルグリッド。
 * 各タイルが自分のタブ (ファイル / Git / ターミナル) を持ち、タイル内で
 * 切り替える。ターミナルはタイルごとのタブとして複数持てる。
 */
export default function WorktreeView({ repo, worktree }: { repo: Repo; worktree: Worktree }) {
  const { refresh, setError } = useDeck();
  const [syncing, setSyncing] = useState<string | null>(null);
  const { sessions, create, kill } = useTerminalSessions(worktree.path);
  const tiles = useTileLayout(worktree.path, sessions, create, kill);

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
            className="claude-launch"
            title="このWorktreeでClaude Codeを起動 (フォーカス中のタイルに開く)"
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
