import { useState } from 'react';
import { useT } from '../i18n';
import type { TerminalSession } from '../types';
import { useConfirm } from './ConfirmDialog';
import { middleClickAutoscrollGuard, middleClickClose } from './editorTabs';
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
  onActivate,
  onCloseTab,
  create,
}: {
  sessions: TerminalSession[] | null;
  ownedIds: string[];
  activeId: string | null;
  /** このビューが表示中か (アクティブ端末のフォーカス制御用) */
  visible: boolean;
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

  return (
    <div className="term-panel">
      <div className="editor-tabs" {...middleClickAutoscrollGuard}>
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
              {session && <StatusBadge status={session.status} compact />}
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
      {dialog}
    </div>
  );
}
