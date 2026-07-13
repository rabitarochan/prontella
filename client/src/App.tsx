import { useEffect, useMemo, useState } from 'react';
import { connectAgentEvents, useAgentEvents, waitingSessions } from './agentEvents';
import { useDeck, findSelection } from './store';
import { useSearchHotkeys } from './search/useSearchHotkeys';
import type { FilesTabHandle } from './search/registry';
import AttentionBell from './components/AttentionBell';
import Sidebar from './components/Sidebar';
import DeckView from './components/DeckView';
import QuickOpenModal from './components/QuickOpenModal';
import WorktreeView from './components/WorktreeView';

const POLL_MS = 4000;

export default function App() {
  const { repos, loaded, selected, error, refresh, setError } = useDeck();
  const sessions = useAgentEvents((s) => s.sessions);
  const [quickOpenTarget, setQuickOpenTarget] = useState<FilesTabHandle | null>(null);
  useSearchHotkeys(setQuickOpenTarget);

  useEffect(() => {
    void refresh();
    connectAgentEvents();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // タブタイトルにバッジ: 他のタブで作業中でも確認待ちの発生が分かる
  const waitingCount = useMemo(() => waitingSessions(sessions).length, [sessions]);
  useEffect(() => {
    document.title = waitingCount > 0 ? `(${waitingCount}) 確認待ち — Claude Deck` : 'Claude Deck';
  }, [waitingCount]);

  const current = findSelection(repos, selected);

  return (
    <div className="app">
      <header className="topbar">
        <span className="topbar-logo" onClick={() => useDeck.getState().select(null)}>
          ◆ Claude Deck
        </span>
        <span className="topbar-sub">repos: {repos.length}</span>
        <span className="topbar-right">
          {error && (
            <span className="topbar-error" onClick={() => setError(null)} title="クリックで閉じる">
              ⚠ {error}
            </span>
          )}
          <AttentionBell />
        </span>
      </header>
      <div className="body">
        <Sidebar />
        <main className="main">
          {!loaded ? (
            <div className="placeholder">読み込み中...</div>
          ) : current ? (
            <WorktreeView key={current.worktree.path} repo={current.repo} worktree={current.worktree} />
          ) : (
            <DeckView />
          )}
        </main>
      </div>
      {quickOpenTarget && (
        <QuickOpenModal target={quickOpenTarget} onClose={() => setQuickOpenTarget(null)} />
      )}
    </div>
  );
}
