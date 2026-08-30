import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import { useTileBarSlots } from '../layout/tileBarSlots';
import type { TerminalSession } from '../types';
import { useConfirm } from './ConfirmDialog';
import { middleClickAutoscrollGuard, middleClickClose } from './editorTabs';
import AgentActivityStrip from './AgentActivityStrip';
import StatusBadge from './StatusBadge';
import XTermView from './XTermView';

/**
 * ターミナルのタブ切り替えビュー (タイル内の「ターミナル」ビュー)。
 * タブ列 (ownedIds) と アクティブタブはタイルツリー側が持つ制御型コンポーネント。
 * 全セッションの xterm をマウントしたまま display で切り替えるので、タブを
 * 行き来してもスクロールバックと接続が残る。終了したセッションのタブは
 * (最後の出力を確認できるよう) 手動で閉じるまで残る。
 */
export default function TermPanel({
  sessions,
  ownedIds,
  activeId,
  visible,
  leafId,
  onActivate,
  onCloseTab,
  create,
}: {
  sessions: TerminalSession[] | null;
  ownedIds: string[];
  activeId: string | null;
  /** このビューが表示中か (アクティブ端末のフォーカス制御用) */
  visible: boolean;
  /** タイルの leaf id。タイルバーのスロット (tileBarSlots) の参照キー。 */
  leafId: string;
  onActivate: (id: string) => void;
  onCloseTab: (id: string) => Promise<void>;
  create: (run?: string) => Promise<void>;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const { confirm, dialog } = useConfirm();
  const liveMap = new Map((sessions ?? []).map((s) => [s.id, s]));
  // ツリー側の activeSession が欠けていても描画は破綻させない
  const active = activeId && ownedIds.includes(activeId) ? activeId : (ownedIds[ownedIds.length - 1] ?? null);

  const run = (fn: () => Promise<void>) => {
    setBusy(true);
    void fn().finally(() => setBusy(false));
  };

  const closeTab = async (id: string) => {
    if (liveMap.has(id)) {
      const ok = await confirm({
        title: t('term.closeTerminalTitle'),
        message: t('term.closeTerminalMessage'),
        confirmLabel: t('term.closeConfirm'),
        severity: 'danger',
      });
      if (!ok) return;
    }
    run(() => onCloseTab(id));
  };

  // セッションタブ行: 表示中はタイルバーのメインゾーンへポータルして 1 段化。
  // スロット未登録時のみパネル内へインライン描画するフォールバック。
  const barSlot = useTileBarSlots((s) => s.slots[leafId] ?? null);
  const inBar = visible && barSlot !== null;
  // アクティブなターミナルの hook 由来アクティビティ (実行中ツール + サブエージェント)。
  // hook が届かないセッションでは activity が null になり、バー自体を出さない。
  const activity = (active ? liveMap.get(active)?.activity : null) ?? null;
  const showActivity =
    activity !== null && (activity.tool !== null || activity.subagents.length > 0);

  const tabsRow = (
    <div className={`editor-tabs${inBar ? ' in-bar' : ''}`} {...middleClickAutoscrollGuard}>
      {ownedIds.map((id) => {
          const session = liveMap.get(id) ?? null;
          return (
            <div
              key={id}
              className={`editor-tab ${active === id ? 'active' : ''}`}
              title={session ? `${session.title} — ${session.cwd}` : t('term.sessionEndedTitle')}
              onClick={() => onActivate(id)}
              {...middleClickClose(() => void closeTab(id))}
            >
              <span className="codicon codicon-terminal" />
              <span className="editor-tab-name">{session?.title ?? t('term.endedLabel')}</span>
              {session && <StatusBadge status={session.status} dot />}
              <span className="editor-tab-actions">
                <button
                  className="editor-tab-close"
                  title={session ? t('term.closeTerminalTitle') : t('term.closeTabTitle')}
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
            className="icon-btn"
            title={t('term.newShell')}
            disabled={busy}
            onClick={() => run(() => create())}
          >
            <span className="codicon codicon-add" />
          </button>
          <button
            className="icon-btn term-claude"
            title={t('term.launchClaudeTitle')}
            disabled={busy}
            onClick={() => run(() => create('claude'))}
          >
            ✦
          </button>
        </span>
    </div>
  );

  return (
    <div className="term-panel">
      {inBar && barSlot ? createPortal(tabsRow, barSlot) : tabsRow}
      <div className="term-body">
        {ownedIds.length === 0 && (
          <div className="term-empty">
            {sessions === null ? (
              <p>{t('term.connecting')}</p>
            ) : (
              <>
                <p>{t('term.empty')}</p>
                <div className="term-empty-buttons">
                  <button disabled={busy} onClick={() => run(() => create())}>
                    {t('term.newShellButton')}
                  </button>
                  <button
                    className="claude"
                    disabled={busy}
                    onClick={() => run(() => create('claude'))}
                  >
                    {t('term.launchClaudeButton')}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        {ownedIds.map((id) => (
          <XTermView
            key={id}
            id={id}
            claudeMode={liveMap.get(id)?.claudeDetected ?? false}
            visible={visible && active === id}
          />
        ))}
      </div>
      {showActivity && activity && (
        <div className="term-statusbar">
          <AgentActivityStrip
            tool={activity.tool}
            toolSince={activity.toolSince}
            subagents={activity.subagents}
          />
        </div>
      )}
      {dialog}
    </div>
  );
}
