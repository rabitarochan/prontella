import { create } from 'zustand';
import { chime, desktopNotify } from './notify';
import { useDeck } from './store';
import type { Repo, TerminalSession, Worktree } from './types';

// /ws/events を購読して全セッションのステータスを保持し、
// 「要対応」への遷移 (→waiting, busy→idle) で通知を出すストア。
// デッキ一覧の 4 秒ポーリングとは独立に、遷移を即座に受け取る。

const RECONNECT_MS = 3_000;
// ヒューリスティック検知の揺れ (スピナー停止→再開) による busy/idle の
// フリップで完了通知が乱発しないよう、idle が少し続いてから通知する。
const DONE_SETTLE_MS = 4_000;

interface AgentEventsState {
  sessions: Record<string, TerminalSession>;
  desktopEnabled: boolean;
  soundEnabled: boolean;
  setDesktopEnabled: (v: boolean) => void;
  setSoundEnabled: (v: boolean) => void;
}

function loadPref(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === '1';
  } catch {
    return fallback;
  }
}

function savePref(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // private mode etc.
  }
}

export const useAgentEvents = create<AgentEventsState>((set) => ({
  sessions: {},
  desktopEnabled: loadPref('deck3.notify.desktop', true),
  soundEnabled: loadPref('deck3.notify.sound', true),
  setDesktopEnabled: (v) => {
    savePref('deck3.notify.desktop', v);
    set({ desktopEnabled: v });
  },
  setSoundEnabled: (v) => {
    savePref('deck3.notify.sound', v);
    set({ soundEnabled: v });
  },
}));

const normPath = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** セッションの cwd から登録済み worktree を引く (パス表記の揺れは正規化)。 */
export function findWorktree(cwd: string): { repo: Repo; worktree: Worktree } | null {
  const key = normPath(cwd);
  for (const repo of useDeck.getState().repos) {
    for (const worktree of repo.worktrees) {
      if (normPath(worktree.path) === key) return { repo, worktree };
    }
  }
  return null;
}

export function sessionLabel(session: TerminalSession): string {
  const hit = findWorktree(session.cwd);
  if (hit) return `${hit.repo.name} / ${hit.worktree.branch ?? '(detached)'}`;
  return session.cwd.split(/[\\/]/).pop() || session.cwd;
}

export function waitingSessions(sessions: Record<string, TerminalSession>): TerminalSession[] {
  return Object.values(sessions)
    .filter((s) => s.status === 'waiting')
    .sort((a, b) => a.statusSince - b.statusSince);
}

function focusSession(session: TerminalSession): void {
  const hit = findWorktree(session.cwd);
  if (hit) useDeck.getState().select({ repoId: hit.repo.id, worktreePath: hit.worktree.path });
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
      kind === 'waiting' ? '確認待ち — Claude Deck' : '完了 — Claude Deck',
      kind === 'waiting'
        ? `${label}: エージェントが応答を待っています`
        : `${label}: エージェントが待機中になりました`,
      `deck3-${kind}-${session.id}`,
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

/** /ws/events への接続を開始する (アプリで一度だけ呼ぶ)。切断時は自動再接続。 */
export function connectAgentEvents(): void {
  if (started) return;
  started = true;
  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/events`);
    ws.onmessage = (ev) => {
      let msg: {
        type: string;
        sessions?: TerminalSession[];
        session?: TerminalSession;
        id?: string;
      };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === 'snapshot' && Array.isArray(msg.sessions)) {
        for (const id of doneTimers.keys()) cancelDoneTimer(id);
        useAgentEvents.setState({
          sessions: Object.fromEntries(msg.sessions.map((s) => [s.id, s])),
        });
      } else if (msg.type === 'session' && msg.session) {
        handleSession(msg.session);
      } else if (msg.type === 'removed' && typeof msg.id === 'string') {
        handleRemoved(msg.id);
      }
    };
    ws.onclose = () => {
      setTimeout(open, RECONNECT_MS);
    };
  };
  open();
}
