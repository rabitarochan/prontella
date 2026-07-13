import { useState } from 'react';
import type { TerminalSession } from '../types';
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
  const [busy, setBusy] = useState(false);
  const liveMap = new Map((sessions ?? []).map((s) => [s.id, s]));
  // ツリー側の activeSession が欠けていても描画は破綻させない
  const active = activeId && ownedIds.includes(activeId) ? activeId : (ownedIds[ownedIds.length - 1] ?? null);

  const run = (fn: () => Promise<void>) => {
    setBusy(true);
    void fn().finally(() => setBusy(false));
  };

  const closeTab = (id: string) => {
    if (liveMap.has(id) && !confirm('このターミナルを終了しますか?')) return;
    run(() => onCloseTab(id));
  };

  return (
    <div className="term-panel">
      <div className="editor-tabs">
        {ownedIds.map((id) => {
          const session = liveMap.get(id) ?? null;
          return (
            <div
              key={id}
              className={`editor-tab ${active === id ? 'active' : ''}`}
              title={session ? `${session.title} — ${session.cwd}` : 'セッションは終了しました'}
              onClick={() => onActivate(id)}
            >
              <span className="codicon codicon-terminal" />
              <span className="editor-tab-name">{session?.title ?? '(終了)'}</span>
              {session && <StatusBadge status={session.status} compact />}
              <span className="editor-tab-actions">
                <button
                  className="editor-tab-close"
                  title={session ? 'ターミナルを終了' : 'タブを閉じる'}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(id);
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
            title="新しいシェル"
            disabled={busy}
            onClick={() => run(() => create())}
          >
            <span className="codicon codicon-add" />
          </button>
          <button
            className="icon-btn term-claude"
            title="このWorktreeでClaude Codeを起動"
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
              <p>接続中…</p>
            ) : (
              <>
                <p>ターミナルがありません</p>
                <div className="term-empty-buttons">
                  <button disabled={busy} onClick={() => run(() => create())}>
                    ＋ シェル
                  </button>
                  <button
                    className="claude"
                    disabled={busy}
                    onClick={() => run(() => create('claude'))}
                  >
                    ✦ Claude 起動
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
    </div>
  );
}
