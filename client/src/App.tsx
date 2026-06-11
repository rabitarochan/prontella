import { useEffect } from 'react';
import { useDeck, findSelection } from './store';
import Sidebar from './components/Sidebar';
import DeckView from './components/DeckView';
import WorktreeView from './components/WorktreeView';

const POLL_MS = 4000;

export default function App() {
  const { repos, loaded, selected, error, refresh, setError } = useDeck();

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const current = findSelection(repos, selected);

  return (
    <div className="app">
      <header className="topbar">
        <span className="topbar-logo" onClick={() => useDeck.getState().select(null)}>
          ◆ Claude Deck
        </span>
        <span className="topbar-sub">repos: {repos.length}</span>
        {error && (
          <span className="topbar-error" onClick={() => setError(null)} title="クリックで閉じる">
            ⚠ {error}
          </span>
        )}
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
    </div>
  );
}
