import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { useT } from '../i18n';
import { useTileBarSlots } from '../layout/tileBarSlots';
import type { AgentResumableSession, TerminalSession } from '../types';
import ChatView from './ChatView';
import { useConfirm } from './ConfirmDialog';
import { middleClickAutoscrollGuard, middleClickClose } from './editorTabs';
import StatusBadge from './StatusBadge';

/**
 * chat (Agent SDK) セッションのタブ切り替えビュー (タイル内の「チャット」ビュー)。
 * 構造は TermPanel と同型: タブ列とアクティブタブはタイルツリー側が持ち、
 * 全セッションの ChatView をマウントしたまま display で切り替える。
 * ownedIds は TileWorkspace が kind === 'sdk' に絞って渡す。
 */
export default function ChatPanel({
  sessions,
  ownedIds,
  activeId,
  visible,
  leafId,
  root,
  onActivate,
  onCloseTab,
  create,
}: {
  sessions: TerminalSession[] | null;
  ownedIds: string[];
  activeId: string | null;
  /** このビューが表示中か (入力フォーカス制御用) */
  visible: boolean;
  /** タイルの leaf id。タイルバーのスロット (tileBarSlots) の参照キー。 */
  leafId: string;
  /** ワークツリー絶対パス (markdown の相対リンク解決用) */
  root: string;
  onActivate: (id: string) => void;
  onCloseTab: (id: string) => Promise<void>;
  create: (resume?: string) => Promise<void>;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [resumable, setResumable] = useState<AgentResumableSession[]>([]);
  const { confirm, dialog } = useConfirm();

  // 空状態のときだけ再開候補を取りに行く (表示のたびに最新化)
  const empty = ownedIds.length === 0;
  useEffect(() => {
    if (!visible || !empty) return;
    let cancelled = false;
    api
      .agentResumable(root)
      .then((list) => {
        if (!cancelled) setResumable(list);
      })
      .catch(() => {
        // サーバー未対応・一時エラー時はリストなしで良い
      });
    return () => {
      cancelled = true;
    };
  }, [visible, empty, root]);
  const liveMap = new Map((sessions ?? []).map((s) => [s.id, s]));
  // ツリー側の activeSession が別 kind でも描画は破綻させない
  const active = activeId && ownedIds.includes(activeId) ? activeId : (ownedIds[ownedIds.length - 1] ?? null);

  const run = (fn: () => Promise<void>) => {
    setBusy(true);
    void fn().finally(() => setBusy(false));
  };

  const closeTab = async (id: string) => {
    if (liveMap.has(id)) {
      const ok = await confirm({
        title: t('chat.closeChatTitle'),
        message: t('chat.closeChatMessage'),
        confirmLabel: t('chat.closeConfirm'),
        severity: 'danger',
      });
      if (!ok) return;
    }
    run(() => onCloseTab(id));
  };

  const barSlot = useTileBarSlots((s) => s.slots[leafId] ?? null);
  const inBar = visible && barSlot !== null;

  const tabsRow = (
    <div className={`editor-tabs${inBar ? ' in-bar' : ''}`} {...middleClickAutoscrollGuard}>
      {ownedIds.map((id) => {
        const session = liveMap.get(id) ?? null;
        return (
          <div
            key={id}
            className={`editor-tab ${active === id ? 'active' : ''}`}
            title={session ? `${session.title} — ${session.cwd}` : t('chat.sessionEndedTitle')}
            onClick={() => onActivate(id)}
            {...middleClickClose(() => void closeTab(id))}
          >
            <span className="codicon codicon-comment-discussion" />
            <span className="editor-tab-name">{session?.title ?? t('chat.endedLabel')}</span>
            {session && <StatusBadge status={session.status} dot />}
            <span className="editor-tab-actions">
              <button
                className="editor-tab-close"
                title={session ? t('chat.closeChatTitle') : t('term.closeTabTitle')}
                onClick={(e) => {
                  e.stopPropagation();
                  void closeTab(id);
                }}
              >
                <span className="codicon codicon-close" />
              </button>
            </span>
          </div>
        );
      })}
      <span className="term-tab-buttons">
        <button
          className="icon-btn term-claude"
          title={t('chat.newSession')}
          disabled={busy}
          onClick={() => run(() => create())}
        >
          <span className="codicon codicon-add" />
        </button>
      </span>
    </div>
  );

  return (
    <div className="term-panel">
      {inBar && barSlot ? createPortal(tabsRow, barSlot) : tabsRow}
      <div className="chat-body">
        {ownedIds.length === 0 && (
          <div className="term-empty">
            {sessions === null ? (
              <p>{t('term.connecting')}</p>
            ) : (
              <>
                <p>{t('chat.empty')}</p>
                <div className="term-empty-buttons">
                  <button className="claude" disabled={busy} onClick={() => run(() => create())}>
                    {t('chat.newSession')}
                  </button>
                </div>
                {resumable.length > 0 && (
                  <div className="chat-resume-list">
                    <div className="chat-resume-title">{t('chat.resumeListTitle')}</div>
                    {resumable.map((record) => (
                      <div key={record.deckId} className="chat-resume-item">
                        <span className="chat-resume-name" title={record.cwd}>
                          {record.title}
                        </span>
                        <span className="chat-resume-date">
                          {new Date(record.savedAt).toLocaleString()}
                        </span>
                        <button
                          className="chat-resume-go"
                          disabled={busy}
                          onClick={() => run(() => create(record.deckId))}
                        >
                          {t('chat.resume')}
                        </button>
                        <button
                          className="chat-resume-discard"
                          disabled={busy}
                          onClick={() =>
                            run(async () => {
                              await api.discardAgentRecord(record.deckId);
                              setResumable((prev) => prev.filter((r) => r.deckId !== record.deckId));
                            })
                          }
                        >
                          {t('chat.discardRecord')}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}
        {ownedIds.map((id) => (
          <ChatView key={id} id={id} root={root} visible={visible && active === id} />
        ))}
      </div>
      {dialog}
    </div>
  );
}
