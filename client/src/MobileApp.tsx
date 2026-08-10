import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { api } from './api';
import { useT } from './i18n';
import { recordSessionKinds } from './layout/sessionKinds';
import type { AgentResumableSession, TerminalSession } from './types';
import ChatView from './components/ChatView';
import StatusBadge from './components/StatusBadge';

/**
 * スマホ向けの限定ページ (/m)。エージェントパネルの内容だけを見せる。
 * ファイル/ターミナル/タイル操作は持たず、全ワークツリー横断で
 * エージェント (kind: 'sdk') セッションを一覧し、タップで全画面 ChatView。
 * ChatView はデスクトップ版と同じコンポーネントをそのまま再利用する。
 */

const POLL_MS = 3000;

function baseName(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

export default function MobileApp() {
  const t = useT();
  const [sessions, setSessions] = useState<TerminalSession[] | null>(null);
  const [resumable, setResumable] = useState<AgentResumableSession[]>([]);
  const [busy, setBusy] = useState(false);
  // 開いているセッション (id + markdown 解決用の root=cwd)
  const [open, setOpen] = useState<{ id: string; root: string } | null>(null);

  const reload = useCallback(async () => {
    try {
      const list = await api.terminals();
      recordSessionKinds(list);
      setSessions(list.filter((s) => s.kind === 'sdk'));
    } catch {
      // サーバー再起動等。次のポーリングで回復
    }
    try {
      setResumable(await api.agentResumableAll());
    } catch {
      // resumable は任意。失敗しても一覧は出す
    }
  }, []);

  // 一覧表示中だけポーリングする (セッションを開いている間は ChatView が live)
  useEffect(() => {
    if (open) return;
    void reload();
    const timer = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(timer);
  }, [open, reload]);

  const openSession = (s: TerminalSession) => setOpen({ id: s.id, root: s.cwd });

  const resume = (record: AgentResumableSession) => {
    setBusy(true);
    void api
      .createAgent(record.cwd, record.deckId)
      .then((session) => {
        recordSessionKinds([session]);
        setOpen({ id: session.id, root: session.cwd });
      })
      .catch(() => {
        // 失敗時は一覧のまま
      })
      .finally(() => setBusy(false));
  };

  if (open) {
    return (
      <div className="m-app">
        <header className="m-header">
          <button className="m-back" onClick={() => setOpen(null)} title={t('mobile.back')}>
            <ChevronLeft />
            {t('mobile.back')}
          </button>
        </header>
        <div className="m-chat-host">
          {/* ChatView はデスクトップ版と同一。visible=true で全画面表示 */}
          <ChatView id={open.id} root={open.root} visible />
        </div>
      </div>
    );
  }

  return (
    <div className="m-app">
      <header className="m-header m-header-home">
        <span className="m-title">◆ {t('mobile.title')}</span>
        <button
          className="m-refresh"
          disabled={busy}
          onClick={() => void reload()}
          title={t('mobile.refresh')}
        >
          <span className="codicon codicon-refresh" />
        </button>
      </header>
      <div className="m-list">
        {sessions === null ? (
          <p className="m-empty">{t('term.connecting')}</p>
        ) : sessions.length === 0 && resumable.length === 0 ? (
          <p className="m-empty">{t('mobile.noSessions')}</p>
        ) : (
          <>
            {sessions.length > 0 && (
              <section className="m-section">
                <div className="m-section-title">{t('mobile.activeTitle')}</div>
                {sessions.map((s) => (
                  <button key={s.id} className="m-item" onClick={() => openSession(s)}>
                    <StatusBadge status={s.status} dot />
                    <span className="m-item-body">
                      <span className="m-item-name">{s.title}</span>
                      <span className="m-item-cwd">{baseName(s.cwd)}</span>
                    </span>
                    <StatusBadge status={s.status} />
                  </button>
                ))}
              </section>
            )}
            {resumable.length > 0 && (
              <section className="m-section">
                <div className="m-section-title">{t('mobile.savedTitle')}</div>
                {resumable.map((r) => (
                  <button
                    key={r.deckId}
                    className="m-item"
                    disabled={busy}
                    onClick={() => resume(r)}
                  >
                    <span className="codicon codicon-history" />
                    <span className="m-item-body">
                      <span className="m-item-name">{r.title}</span>
                      <span className="m-item-cwd">
                        {baseName(r.cwd)} · {new Date(r.savedAt).toLocaleString()}
                      </span>
                    </span>
                    <span className="m-item-resume">{t('chat.resume')}</span>
                  </button>
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
