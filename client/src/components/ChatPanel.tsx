import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import { useTileBarSlots } from '../layout/tileBarSlots';
import type { TerminalSession } from '../types';
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
  create: () => Promise<void>;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const { confirm, dialog } = useConfirm();
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
