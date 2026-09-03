import { create } from 'zustand';
import { t } from './i18n';
import { chime, desktopNotify } from './notify';
import { openLiveSocket } from './lib/liveSocket';
import { locateSession, normPath } from './sessionLocate';
import { useDeck } from './store';
import type { ActiveRepo, TerminalSession, Worktree } from './types';

// /ws/events を購読して全セッションのステータスを保持し、
// 「要対応」への遷移 (→waiting, busy→idle) で通知を出すストア。
// デッキ一覧の 4 秒ポーリングとは独立に、遷移を即座に受け取る。

// ヒューリスティック検知の揺れ (スピナー停止→再開) による busy/idle の
// フリップで完了通知が乱発しないよう、idle が少し続いてから通知する。
const DONE_SETTLE_MS = 4_000;

interface AgentEventsState {
  sessions: Record<string, TerminalSession>;
  /** /ws/events の snapshot を 1 度でも受けたか。true なら `sessions` が全セッションの顔ぶれとして信頼できる。 */
  loaded: boolean;
  desktopEnabled: boolean;
  soundEnabled: boolean;
  setDesktopEnabled: (v: boolean) => void;
  setSoundEnabled: (v: boolean) => void;
}

// Sidebar のアーカイブ折りたたみ永続化 (prontella.sidebar.archivedOpen) でも再利用する
// 汎用の boolean pref ヘルパー。notify 専用ではないためここから export する。
export function loadPref(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === '1';
  } catch {
    return fallback;
  }
}

export function savePref(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // private mode etc.
  }
}

export const useAgentEvents = create<AgentEventsState>((set) => ({
  sessions: {},
  loaded: false,
  desktopEnabled: loadPref('prontella.notify.desktop', true),
  soundEnabled: loadPref('prontella.notify.sound', true),
  setDesktopEnabled: (v) => {
    savePref('prontella.notify.desktop', v);
    set({ desktopEnabled: v });
  },
  setSoundEnabled: (v) => {
    savePref('prontella.notify.sound', v);
    set({ soundEnabled: v });
  },
}));

/** セッションの cwd から登録済み worktree を引く (パス表記の揺れは正規化)。アーカイブ済み
 *  repo に属するセッションは null (locateSession 経由。詳細は sessionLocate.ts)。 */
export function findWorktree(cwd: string): { repo: ActiveRepo; worktree: Worktree } | null {
  const location = locateSession(useDeck.getState().repos, cwd);
  return location?.kind === 'worktree' ? { repo: location.repo, worktree: location.worktree } : null;
}

export function sessionLabel(session: TerminalSession): string {
  const location = locateSession(useDeck.getState().repos, session.cwd);
  if (location?.kind === 'worktree') return `${location.repo.name} / ${location.worktree.branch ?? '(detached)'}`;
  if (location?.kind === 'archived') return t('notify.archivedSessionLabel', { name: location.repo.name });
  return session.cwd.split(/[\\/]/).pop() || session.cwd;
}

export function waitingSessions(sessions: Record<string, TerminalSession>): TerminalSession[] {
  return Object.values(sessions)
    .filter((s) => s.status === 'waiting')
    .sort((a, b) => a.statusSince - b.statusSince);
}

/**
 * cwd から選択先を解決して select() する。'archived' ならアーカイブ解除して再解決する
 * (setRepoArchived は needsRefresh を内部で処理するため、ここで別途 refresh() は呼ばない)。
 * 解決できたら true、できなければ false を返す。呼び出し側 (AttentionBell の pick() /
 * デスクトップ通知クリック) で解決不能時の見せ方が異なる (D5: setError は使わずベルパネル内に
 * 表示する) ため、失敗の表示自体はここでは行わない。
 */
export async function resolveAndSelect(cwd: string): Promise<boolean> {
  const location = locateSession(useDeck.getState().repos, cwd);
  if (location?.kind === 'worktree') {
    useDeck.getState().select({ repoId: location.repo.id, worktreePath: location.worktree.path });
    return true;
  }
  if (location?.kind === 'archived') {
    const ok = await useDeck.getState().setRepoArchived(location.repo.id, false);
    if (!ok) return false;
    const relocated = locateSession(useDeck.getState().repos, cwd);
    if (relocated?.kind !== 'worktree') return false;
    useDeck.getState().select({ repoId: relocated.repo.id, worktreePath: relocated.worktree.path });
    return true;
  }
  return false;
}

// デスクトップ通知クリック由来。エラーを表示する UI 面が無いため、解決不能時は
// サイレントに諦める(既存の「何も起きない」挙動を維持。ベル経由のクリック
// (AttentionBell の pick()) は別途エラーをパネル内に表示する)。
function focusSession(session: TerminalSession): void {
  void resolveAndSelect(session.cwd);
}

function notify(kind: 'waiting' | 'done', session: TerminalSession): void {
  const { desktopEnabled, soundEnabled } = useAgentEvents.getState();
  // タブが見えていて該当 worktree を開いているなら、目の前の出来事なので通知しない
  if (!document.hidden) {
    const hit = findWorktree(session.cwd);
    const selected = useDeck.getState().selected;
    if (hit && selected && normPath(selected.worktreePath) === normPath(hit.worktree.path)) return;
  }
  const label = sessionLabel(session);
  if (soundEnabled) chime(kind);
  if (desktopEnabled) {
    desktopNotify(
      t(kind === 'waiting' ? 'notify.waitingTitle' : 'notify.doneTitle'),
      t(kind === 'waiting' ? 'notify.waitingBody' : 'notify.doneBody', { label }),
      `prontella-${kind}-${session.id}`,
      () => focusSession(session),
    );
  }
}

const doneTimers = new Map<string, number>();

function cancelDoneTimer(id: string): void {
  const timer = doneTimers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    doneTimers.delete(id);
  }
}

function handleSession(next: TerminalSession): void {
  const prev = useAgentEvents.getState().sessions[next.id];
  useAgentEvents.setState((s) => ({ sessions: { ...s.sessions, [next.id]: next } }));
  // 初見 (このページを開く前から居たセッションは snapshot で入る) は遷移が
  // 分からないので通知しない。
  if (!prev || prev.status === next.status) return;
  if (next.status !== 'idle') cancelDoneTimer(next.id);
  if (next.status === 'waiting') {
    notify('waiting', next);
  } else if (next.status === 'idle' && prev.status === 'busy' && next.claudeDetected) {
    cancelDoneTimer(next.id);
    const timer = window.setTimeout(() => {
      doneTimers.delete(next.id);
      const current = useAgentEvents.getState().sessions[next.id];
      if (current && current.status === 'idle') notify('done', current);
    }, DONE_SETTLE_MS);
    doneTimers.set(next.id, timer);
  }
}

function handleRemoved(id: string): void {
  cancelDoneTimer(id);
  useAgentEvents.setState((s) => {
    if (!(id in s.sessions)) return s;
    const sessions = { ...s.sessions };
    delete sessions[id];
    return { sessions };
  });
}

let started = false;

/**
 * /ws/events への接続を開始する (アプリで一度だけ呼ぶ)。
 *
 * 切断時の再接続とハートビートは openLiveSocket が持つ。ここは表示していない
 * ターミナルのステータスが届く唯一の経路なので、close が飛ばない半死ソケット
 * (スリープ・Wi-Fi 切替) を検知できないと「通知が来ない」に直結する。
 */
export function connectAgentEvents(): void {
  if (started) return;
  started = true;
  openLiveSocket({
    path: '/ws/events',
    onMessage: (raw) => {
      const msg = raw as {
        type?: string;
        sessions?: TerminalSession[];
        session?: TerminalSession;
        id?: string;
      };
      if (msg.type === 'snapshot' && Array.isArray(msg.sessions)) {
        for (const id of doneTimers.keys()) cancelDoneTimer(id);
        useAgentEvents.setState({
          sessions: Object.fromEntries(msg.sessions.map((s) => [s.id, s])),
          loaded: true,
        });
      } else if (msg.type === 'session' && msg.session) {
        handleSession(msg.session);
      } else if (msg.type === 'removed' && typeof msg.id === 'string') {
        handleRemoved(msg.id);
      }
    },
  });
}
