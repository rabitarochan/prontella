import { useEffect, useMemo, useState } from 'react';
import { connectAgentEvents, useAgentEvents, waitingSessions } from './agentEvents';
import { useT } from './i18n';
import { useDeck, findSelection } from './store';
import { useSearchHotkeys } from './search/useSearchHotkeys';
import type { FilesTabHandle } from './search/registry';
import type { ActiveRepo } from './types';
import AddWorktreeModal from './components/AddWorktreeModal';
import CommandPalette from './components/CommandPalette';
import DeckView from './components/DeckView';
import QuickOpenModal from './components/QuickOpenModal';
import Rail from './components/Rail';
import VncPane from './components/VncPane';
import WorktreeView from './components/WorktreeView';
import { useVncPane } from './layout/vncPaneStore';

const POLL_MS = 4000;

export default function App() {
  const t = useT();
  const { repos, loaded, selected, error, refresh, setError } = useDeck();
  const sessions = useAgentEvents((s) => s.sessions);
  const [quickOpenTarget, setQuickOpenTarget] = useState<FilesTabHandle | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [worktreeTarget, setWorktreeTarget] = useState<ActiveRepo | null>(null);
  const vncVisited = useVncPane((s) => s.visited);
  useSearchHotkeys(setQuickOpenTarget);

  // Ctrl+K = グローバルコマンドパレット。Ctrl+P (ファイル検索) と同じ流儀:
  // ターミナルフォーカス中はシェルの Ctrl+K を奪わない。capture で Monaco より先に拾う。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== 'k') return;
      if ((e.target as HTMLElement | null)?.closest?.('.xterm')) return;
      e.preventDefault();
      e.stopPropagation();
      setPaletteOpen((v) => !v);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  useEffect(() => {
    void refresh();
    connectAgentEvents();
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer !== null) return;
      timer = setInterval(() => void refresh(), POLL_MS);
    };
    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };
    // ブラウザータブが非表示の間は 4 秒ポーリングを止める (サーバー側の git.exe 起動を抑える)。
    // 再表示された瞬間に即 refresh() してから interval を再開する。
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        stop();
      } else {
        void refresh();
        start();
      }
    };
    if (document.visibilityState !== 'hidden') start();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      stop();
    };
  }, [refresh]);

  // タブタイトルにバッジ: 他のタブで作業中でも確認待ちの発生が分かる
  const waitingCount = useMemo(() => waitingSessions(sessions).length, [sessions]);
  useEffect(() => {
    document.title =
      waitingCount > 0 ? t('app.titleWaiting', { n: waitingCount }) : 'Claude Deck';
  }, [waitingCount, t]);

  const current = findSelection(repos, selected);

  return (
    <div className="app">
      <Rail onOpenPalette={() => setPaletteOpen(true)} />
      <main className="main">
        {error && (
          <div className="main-error" onClick={() => setError(null)} title={t('common.clickToDismiss')}>
            ⚠ {error}
          </div>
        )}
        {!loaded ? (
          <div className="placeholder">{t('common.loading')}</div>
        ) : current ? (
          <WorktreeView key={current.worktree.path} repo={current.repo} worktree={current.worktree} />
        ) : (
          <DeckView />
        )}
      </main>
      {/* VNC ペインは worktree 切替 (WorktreeView の key remount) の影響を受けない
          App 直下に置き、一度開いたら閉じても unmount しない (RFB 接続の生存条件)。 */}
      {vncVisited && <VncPane />}
      {quickOpenTarget && (
        <QuickOpenModal target={quickOpenTarget} onClose={() => setQuickOpenTarget(null)} />
      )}
      {paletteOpen && (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          onOpenQuickOpen={setQuickOpenTarget}
          onAddWorktree={setWorktreeTarget}
        />
      )}
      {worktreeTarget && (
        <AddWorktreeModal repo={worktreeTarget} onClose={() => setWorktreeTarget(null)} />
      )}
    </div>
  );
}
