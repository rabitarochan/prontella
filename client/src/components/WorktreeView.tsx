import type { ActiveRepo, Worktree } from '../types';
import { useTerminalSessions } from '../layout/useTerminalSessions';
import { useTileLayout } from '../layout/useTileLayout';
import { useConfirm } from './ConfirmDialog';
import StatusBadge from './StatusBadge';
import TileGrid from './tiles/TileGrid';

/**
 * Worktree のメインビュー: 分割・リサイズできるタイルグリッド。
 * ヘッダーはパンくず (repo / branch / 状態) のみ。fetch/pull/push は
 * GitTab の同期バーへ、Claude 起動はターミナルパネルへ移設済み (P8-2)。
 */
export default function WorktreeView({ repo, worktree }: { repo: ActiveRepo; worktree: Worktree }) {
  const { confirm: confirmDialog, dialog } = useConfirm();
  const { sessions, create, kill } = useTerminalSessions(worktree.path);
  const tiles = useTileLayout(worktree.path, sessions, create, kill);

  return (
    <div className="wt-view">
      <div className="wt-header">
        <div className="wt-header-info">
          <span className="wt-header-repo">{repo.name}</span>
          <span className="wt-crumb-sep">/</span>
          <span className="wt-header-branch">
            {repo.gitMode === 'none' ? '(Git なし)' : (worktree.branch ?? `(detached ${worktree.head})`)}
          </span>
          <StatusBadge status={worktree.agent.status} />
        </div>
        <div className="wt-header-actions">
          <button
            className="icon-btn layout-reset"
            title="レイアウトを初期化"
            onClick={() => {
              void (async () => {
                const ok = await confirmDialog({
                  title: 'レイアウトを初期化',
                  message: 'レイアウトを初期化しますか?(未保存の編集内容は失われます)',
                  confirmLabel: '初期化',
                  severity: 'danger',
                });
                if (ok) tiles.reset();
              })();
            }}
          >
            <span className="codicon codicon-layout" />
          </button>
        </div>
      </div>
      <div className="wt-body">
        <TileGrid repo={repo} worktree={worktree} sessions={sessions} actions={tiles} />
      </div>
      {dialog}
    </div>
  );
}
