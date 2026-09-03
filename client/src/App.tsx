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
import TerminalMonitorView from './components/TerminalMonitorView';
import VncView from './components/VncView';
import WorktreeView from './components/WorktreeView';
import { useMonitorView } from './layout/monitorViewStore';
import { useVncView } from './layout/vncViewStore';
import { usePageActivity, wirePageActivity } from './lib/pageActivity';

// 全 worktree の git 状態 (/api/repos) の更新間隔。フォーカスのあるページだけ短く、
// 別ウィンドウで眺めているだけ (可視だがフォーカスなし) なら長くする。エージェントの
// ステータスは /ws/events のプッシュで届くので、ここが遅くても「確認待ち」の検知は遅れない。
const POLL_MS = 4000;
const POLL_UNFOCUSED_MS = 15_000;

export default function App() {
  const t = useT();
  const { repos, loaded, selected, error, refresh, setError } = useDeck();
  const sessions = useAgentEvents((s) => s.sessions);
  const [quickOpenTarget, setQuickOpenTarget] = useState<FilesTabHandle | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [worktreeTarget, setWorktreeTarget] = useState<ActiveRepo | null>(null);
  const vncActive = useVncView((s) => s.active);
  const vncVisited = useVncView((s) => s.visited);
  const setVncActive = useVncView((s) => s.setActive);
  const monitorActive = useMonitorView((s) => s.active);
  const setMonitorActive = useMonitorView((s) => s.setActive);
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
    wirePageActivity();
    let timer: ReturnType<typeof setInterval> | null = null;
    let currentMs = 0;
    // 非表示 = 停止 (サーバー側の git.exe 起動を抑える) / 可視かつフォーカスあり = 4 秒 /
    // 可視だがフォーカスなし (別ウィンドウで眺めているだけ) = 15 秒。
    const desiredMs = () => {
      if (document.visibilityState === 'hidden') return 0;
      return usePageActivity.getState().active ? POLL_MS : POLL_UNFOCUSED_MS;
    };
    // kick = 間隔が変わる契機で即 1 回 refresh する (再表示・フォーカス復帰)。
    const apply = (kick: boolean) => {
      const ms = desiredMs();
      if (ms === currentMs) return;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      currentMs = ms;
      if (ms === 0) return;
      if (kick) void refresh();
      timer = setInterval(() => void refresh(), ms);
    };
    apply(false);
    const onVisibilityChange = () => apply(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVisibilityChange);
    const unsubscribe = usePageActivity.subscribe((s) => apply(s.active));
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      unsubscribe();
      if (timer !== null) clearInterval(timer);
    };
  }, [refresh]);

  // タブタイトルにバッジ: 他のタブで作業中でも確認待ちの発生が分かる
  const waitingCount = useMemo(() => waitingSessions(sessions).length, [sessions]);
  useEffect(() => {
    document.title =
      waitingCount > 0 ? t('app.titleWaiting', { n: waitingCount }) : 'Prontella';
  }, [waitingCount, t]);

  const current = findSelection(repos, selected);

  // リポジトリー/worktree を選択したら VNC モードを抜ける (左ツリーの選択が常に優先)。
  // VncView 自体は visited 維持で display:none にするだけなので RFB 接続は生存する。
  useEffect(() => {
    if (current && vncActive) setVncActive(false);
  }, [current, vncActive, setVncActive]);

  // ターミナルモニターも同じ規則 (選択優先)。VNC とは排他で、両方が保存状態に
  // 残っていた場合 (通常は layout/mainMode が防ぐ) は VNC を優先しモニターを降ろす。
  useEffect(() => {
    if (monitorActive && (current || vncActive)) setMonitorActive(false);
  }, [current, vncActive, monitorActive, setMonitorActive]);

  const vncVisible = loaded && vncActive && !current;

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
        ) : vncActive ? null : monitorActive ? (
          <TerminalMonitorView />
        ) : (
          <DeckView />
        )}
        {/* VNC ビューは worktree 切替 (WorktreeView の key remount) の影響を受けない
            main 直下の兄弟に置き、一度入ったらモードを抜けても unmount しない
            (display:none 保持が RFB 接続の生存条件)。 */}
        {vncVisited && <VncView visible={vncVisible} />}
      </main>
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
