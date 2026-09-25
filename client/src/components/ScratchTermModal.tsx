import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { useScratchTerm } from '../layout/scratchTermStore';
import { useTerminalSessions } from '../layout/useTerminalSessions';
import TermPanel from './TermPanel';

/**
 * 一時ターミナル: どの workspace (worktree) にも属さない、ホームディレクトリーで
 * 開くターミナルのモーダル。Ctrl+@ で開閉する。
 *
 * 実体は TermPanel の再利用 (worktree のタイル / ターミナルモニターに続く 3 例目)。
 * 所有権の出所が「タイルの leaf.sessions」でも「サーバー上の全セッション」でもなく、
 * **このビューがローカルに持つ追加専用の id 列**になるだけ。追加専用にするのは、
 * 終了したターミナルのタブを (最後の出力を確認できるよう) 手で閉じるまで残す
 * ためで、worktree のターミナルパネルと同じ挙動になる。
 *
 * 閉じてもアンマウントしない (App 側が visited で保持し、ここは display:none に
 * なるだけ)。xterm は再マウントで WebSocket が張り直されスクロールバックが
 * 消えるため (pj-client-ui-state §14)。
 */

/** グループツリーの永続化キー (termState は worktree パスで引くので擬似パス)。
 *  実パス (homeDir) を使わないのは、パス取得前でも復元できるようにするため。 */
export const SCRATCH_TERM_ROOT = '__scratch__';
export const SCRATCH_LEAF_ID = 'scratch';

export default function ScratchTermModal({ homeDir }: { homeDir: string }) {
  const t = useT();
  const open = useScratchTerm((s) => s.open);
  const setOpen = useScratchTerm((s) => s.setOpen);
  const { sessions } = useTerminalSessions(homeDir);
  const [activeId, setActiveId] = useState<string | null>(null);

  // 所有 ID は追加のみ。サーバーは終了したセッションを list から落とすので、
  // ここに残った id が TermPanel 側で「(終了)」タブになる。
  const [ownedIds, setOwnedIds] = useState<string[]>([]);
  useEffect(() => {
    if (!sessions) return;
    setOwnedIds((prev) => {
      const seen = new Set(prev);
      const added = sessions.filter((s) => s.kind === 'pty' && !seen.has(s.id)).map((s) => s.id);
      return added.length > 0 ? [...prev, ...added] : prev;
    });
  }, [sessions]);

  // useTerminalSessions の create/kill は使わない: どちらも refreshDeck()
  // (= /api/repos。git を約 40 本起動して 3〜9 秒) を伴うが、ホームのセッションは
  // どの worktree の git 状態も変えないので完全に無駄。一覧への反映は
  // /ws/events のプッシュが行う (TerminalMonitorView も同じ理由で直接叩いている)。
  const create = useCallback(
    async (run: string | undefined) => {
      await api.createTerminal(homeDir, run);
    },
    [homeDir],
  );

  // 終了済みのタブはサーバーに居ないので kill は空振りする。確認ダイアログは
  // TermPanel.closeTab が live なタブにだけ出す。
  const onCloseTab = useCallback(async (id: string) => {
    await api.killTerminal(id).catch(() => undefined);
    setOwnedIds((prev) => prev.filter((x) => x !== id));
  }, []);

  return (
    <div
      className="scratch-backdrop"
      style={{ display: open ? undefined : 'none' }}
      onMouseDown={() => setOpen(false)}
    >
      <div className="scratch-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="monitor-header">
          <span className="codicon codicon-terminal" />
          <span className="monitor-header-title">{t('scratch.title')}</span>
          <span className="monitor-header-count">{homeDir}</span>
          <span className="monitor-header-hint" title={t('scratch.hint')}>
            <span className="codicon codicon-info" />
          </span>
          <span className="monitor-header-spacer" />
          <button className="icon-btn" title={t('scratch.close')} onClick={() => setOpen(false)}>
            <span className="codicon codicon-close" />
          </button>
        </div>
        <div className="monitor-body">
          <TermPanel
            leafId={SCRATCH_LEAF_ID}
            root={SCRATCH_TERM_ROOT}
            sessions={sessions}
            ownedIds={ownedIds}
            activeId={activeId}
            visible={open}
            onActivate={setActiveId}
            onCloseTab={onCloseTab}
            create={(run) => create(run)}
          />
        </div>
      </div>
    </div>
  );
}
