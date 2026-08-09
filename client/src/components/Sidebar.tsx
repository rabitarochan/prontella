import { useEffect, useState, type DragEvent, type MouseEvent } from 'react';
import { api } from '../api';
import { loadPref, savePref } from '../agentEvents';
import { useT } from '../i18n';
import { beginRepoMutation, useDeck } from '../store';
import { removeWorktreeLocalState } from '../editorState';
import { isActive, isArchived, moveByOffset, moveWithinSection, sectionize } from '../repoSections';
import type { ActiveRepo, ArchivedRepo, Repo } from '../types';
import StatusBadge from './StatusBadge';
import AddWorktreeModal from './AddWorktreeModal';
import { useConfirm } from './ConfirmDialog';
import ContextMenu, { type ContextMenuItem } from './ContextMenu';
import { usePrompt } from './PromptDialog';

const ARCHIVED_OPEN_KEY = 'deck3.sidebar.archivedOpen';

// モジュールスコープ: dragover 中は dataTransfer.getData() が空文字を返す (protected mode) ため、
// ドラッグ中の repo id はここに持つ (React state だと dragover ハンドラーの外側からは読めるが、
// 同期性が保証しやすいモジュール変数の方を正とする)。アンマウント時に useEffect でリセットする。
let draggingRepoId: string | null = null;

type DropTarget = { id: string; position: 'before' | 'after' };

export default function Sidebar() {
  const t = useT();
  const {
    repos,
    selected,
    select,
    refresh,
    setError,
    reorderRepos,
    setRepoPinned,
    setRepoArchived,
  } = useDeck();
  const { confirm: confirmDialog, dialog } = useConfirm();
  const { prompt: promptDialog, dialog: promptDlg } = usePrompt();
  const [worktreeTarget, setWorktreeTarget] = useState<ActiveRepo | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(() => loadPref(ARCHIVED_OPEN_KEY, false));
  const [menu, setMenu] = useState<{ x: number; y: number; repo: Repo } | null>(null);
  // .dragging / .drop-before / .drop-after の描画用 (draggingRepoId 自体はモジュール変数が正)
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  useEffect(() => {
    return () => {
      draggingRepoId = null;
    };
  }, []);

  const { pinned, normal, archived } = sectionize(repos);

  const dropPositionFor = (e: DragEvent<HTMLDivElement>): 'before' | 'after' => {
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
  };

  const handleDragStart = (e: DragEvent<HTMLDivElement>, repo: Repo) => {
    draggingRepoId = repo.id;
    setDraggingId(repo.id);
    e.dataTransfer.effectAllowed = 'move';
    // Firefox はデータが 0 個だとドラッグを開始しない。値自体は dragover 中は読めない
    // (protected mode) ので使わないが、setData 自体は必須。
    e.dataTransfer.setData('text/plain', repo.id);
  };

  // Esc キャンセル時も発火する。状態クリアは drop ではなくここに置く (drop 後も必ず呼ばれる)。
  const handleDragEnd = () => {
    draggingRepoId = null;
    setDraggingId(null);
    setDropTarget(null);
  };

  // dragenter/dragover 共通ハンドラー。両方で e.preventDefault() を呼ばないと drop が発火しない。
  // セクションを跨ぐ等 moveWithinSection が null を返す組み合わせでは preventDefault しない
  // (= ブラウザーが「ドロップ不可」カーソルを出し、インジケーターも出さない・drop も発火しない)。
  const handleDragOver = (e: DragEvent<HTMLDivElement>, repo: Repo) => {
    if (!draggingRepoId || draggingRepoId === repo.id) return;
    const position = dropPositionFor(e);
    const order = moveWithinSection(repos, draggingRepoId, repo.id, position);
    if (!order) {
      setDropTarget((prev) => (prev === null ? prev : null));
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTarget((prev) =>
      prev && prev.id === repo.id && prev.position === position ? prev : { id: repo.id, position },
    );
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>, repo: Repo) => {
    e.preventDefault();
    const draggedId = draggingRepoId;
    if (!draggedId) return;
    const order = moveWithinSection(repos, draggedId, repo.id, dropPositionFor(e));
    if (order) void reorderRepos(order);
  };

  const toggleArchivedOpen = () => {
    setArchivedOpen((prev) => {
      const next = !prev;
      savePref(ARCHIVED_OPEN_KEY, next);
      return next;
    });
  };

  const addRepo = async () => {
    const path = await promptDialog({
      title: t('sidebar.addRepo'),
      message: t('sidebar.addRepoMessage'),
      placeholder: 'C:\\path\\to\\repo',
      confirmLabel: t('common.add'),
    });
    if (!path) return;
    beginRepoMutation();
    try {
      await api.addRepo(path.trim());
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const removeRepo = async (repo: Repo) => {
    const ok = await confirmDialog({
      title: t('sidebar.removeFromDeck'),
      message: t('sidebar.removeRepoMessage', { name: repo.name }),
      confirmLabel: t('common.remove'),
    });
    if (!ok) return;
    beginRepoMutation();
    await api.removeRepo(repo.id);
    if (selected?.repoId === repo.id) select(null);
    await refresh();
  };

  const removeWorktree = async (repo: ActiveRepo, path: string) => {
    const ok = await confirmDialog({
      title: t('sidebar.removeWorktree'),
      message: t('sidebar.removeWorktreeMessage', { path }),
      confirmLabel: t('common.remove'),
      severity: 'danger',
    });
    if (!ok) return;
    try {
      await api.removeWorktree(repo.id, path, false);
      // select(null) は WorktreeView を unmount させ、FilesTab の cleanup flush が
      // editorState キーを再生成してしまう。その flush は refresh() のネットワーク
      // 往復中にコミットされるため、ローカル掃除は select → refresh の後(最後)に
      // 行う必要がある。順序を変えると削除したはずのキーが復活する。
      if (selected?.worktreePath === path) select(null);
      await refresh();
      removeWorktreeLocalState(path);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const force = await confirmDialog({
        title: t('sidebar.forceRemoveWorktree'),
        message: t('sidebar.forceRemoveWorktreeMessage', { message }),
        confirmLabel: t('sidebar.forceRemove'),
        severity: 'danger',
      });
      if (force) {
        let succeeded = false;
        try {
          await api.removeWorktree(repo.id, path, true);
          succeeded = true;
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
        // 通常パスと同じ順序制約(select → refresh → ローカル掃除)。失敗時は
        // worktree がまだ存在するので選択解除もローカル掃除も行わない。
        if (succeeded && selected?.worktreePath === path) select(null);
        await refresh();
        if (succeeded) removeWorktreeLocalState(path);
      }
    }
  };

  // 選択中 repo のアーカイブは既存 removeRepo と同じ順序にする: API → select(null) → refresh()
  // (setRepoArchived 自体は成功しても needsRefresh を返さない — アーカイブへの変換はローカルの
  // applyRepoMeta だけで完結する — ので、選択解除後の再描画のために refresh() をここで呼ぶ)。
  const archiveRepo = async (repo: ActiveRepo) => {
    const hasBusyAgent = repo.worktrees.some(
      (wt) => wt.agent.status === 'busy' || wt.agent.status === 'waiting',
    );
    if (hasBusyAgent) {
      const ok = await confirmDialog({
        title: t('sidebar.archiveRepoTitle'),
        message: t('sidebar.archiveBusyMessage'),
        confirmLabel: t('sidebar.archive'),
      });
      if (!ok) return;
    }
    const wasSelected = selected?.repoId === repo.id;
    const ok = await setRepoArchived(repo.id, true);
    if (ok && wasSelected) {
      select(null);
      await refresh();
    }
  };

  // setRepoArchived(id, false) は needsRefresh を内部で処理する (archived→active は
  // git データが要るため store 側が refresh() まで済ませる)。ここで追加の refresh() は不要。
  const unarchiveRepo = async (repo: ArchivedRepo) => {
    await setRepoArchived(repo.id, false);
  };

  const openMenu = (e: MouseEvent, repo: Repo) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, repo });
  };

  const menuItems = (repo: Repo): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];
    // アーカイブ済み行では「ピン留め」を出さない。ArchivedRepo.pinned は常に false なので
    // ラベルは常に「ピン留め」になり、押すと applyFlags の相互排他で archived が落ちて
    // アクティブ+ピン留めとして無言で復活してしまう。disabled ではなく非表示にする:
    // これは「今は実行できない操作」(上へ/下へ移動の端のような)ではなく「この行の文脈に
    // 存在しない操作」なので、グレーアウトだと理由が伝わらずかえって紛らわしい。
    if (isActive(repo)) {
      items.push({
        label: repo.pinned ? t('sidebar.unpin') : t('sidebar.pin'),
        icon: 'pin',
        onClick: () => void setRepoPinned(repo.id, !repo.pinned),
      });
    }
    items.push(
      {
        label: isArchived(repo) ? t('sidebar.unarchive') : t('sidebar.archive'),
        icon: 'archive',
        onClick: () => void (isArchived(repo) ? unarchiveRepo(repo) : archiveRepo(repo)),
      },
      {
        label: t('sidebar.moveUp'),
        icon: 'arrow-up',
        disabled: moveByOffset(repos, repo.id, -1) === null,
        onClick: () => {
          const order = moveByOffset(repos, repo.id, -1);
          if (order) void reorderRepos(order);
        },
      },
      {
        label: t('sidebar.moveDown'),
        icon: 'arrow-down',
        disabled: moveByOffset(repos, repo.id, 1) === null,
        onClick: () => {
          const order = moveByOffset(repos, repo.id, 1);
          if (order) void reorderRepos(order);
        },
      },
      {
        label: t('sidebar.removeFromDeck'),
        icon: 'trash',
        danger: true,
        onClick: () => void removeRepo(repo),
      },
    );
    return items;
  };

  const groupClassName = (repo: Repo, base: string): string => {
    let cls = base;
    if (draggingId === repo.id) cls += ' dragging';
    if (dropTarget && dropTarget.id === repo.id) cls += ` drop-${dropTarget.position}`;
    return cls;
  };

  const renderActiveRow = (repo: ActiveRepo) => (
    <div key={repo.id} className={groupClassName(repo, 'repo-group')}>
      <div
        className="repo-row"
        draggable
        onDragStart={(e) => handleDragStart(e, repo)}
        onDragEnd={handleDragEnd}
        onDragEnter={(e) => handleDragOver(e, repo)}
        onDragOver={(e) => handleDragOver(e, repo)}
        onDrop={(e) => handleDrop(e, repo)}
        onContextMenu={(e) => openMenu(e, repo)}
      >
        <span className="repo-name" title={repo.path}>
          {repo.name}
        </span>
        <span className="repo-actions">
          {repo.gitMode === 'root' && (
            <button
              className="icon-btn"
              title={t('sidebar.addWorktree')}
              draggable={false}
              onClick={() => setWorktreeTarget(repo)}
            >
              ＋
            </button>
          )}
          <button
            className="icon-btn"
            title={t('sidebar.removeFromDeck')}
            draggable={false}
            onClick={() => void removeRepo(repo)}
          >
            ✕
          </button>
        </span>
      </div>
      {repo.error && <div className="repo-error">⚠ {repo.error}</div>}
      {repo.worktrees.map((wt) => {
        const active = selected?.worktreePath === wt.path;
        const dirty =
          (wt.status?.staged ?? 0) + (wt.status?.unstaged ?? 0) + (wt.status?.untracked ?? 0);
        return (
          <div
            key={wt.path}
            className={`wt-row ${active ? 'active' : ''}`}
            onClick={() => select({ repoId: repo.id, worktreePath: wt.path })}
            title={wt.path}
          >
            <StatusBadge status={wt.agent.status} dot />
            <span className="wt-branch">
              {repo.gitMode === 'none'
                ? t('common.noGit')
                : (wt.branch ?? t('common.detached', { head: wt.head }))}
              {repo.gitMode === 'root' && wt.isMain && <span className="wt-main-mark"> ●main</span>}
            </span>
            {dirty > 0 && <span className="wt-dirty">±{dirty}</span>}
            {!wt.isMain && (
              <button
                className="icon-btn wt-remove"
                title={t('sidebar.removeWorktree')}
                onClick={(e) => {
                  e.stopPropagation();
                  void removeWorktree(repo, wt.path);
                }}
              >
                ✕
              </button>
            )}
          </div>
        );
      })}
    </div>
  );

  // アーカイブ済み行: 名前のみ。StatusBadge/ブランチ名/変更数/＋/worktree 行は描画しない。
  // 行クリックは no-op (onClick を持たせない)。DnD ハンドルは通常行と同じ .repo-row 上に持つ
  // (右クリックメニューの「上へ移動/下へ移動」が既にこのセクションで動くため、DnD だけ無効に
  // すると一貫性がない — moveWithinSection がセクション跨ぎを構造的に弾くので安全)。
  const renderArchivedRow = (repo: ArchivedRepo) => (
    <div key={repo.id} className={groupClassName(repo, 'repo-group')}>
      <div
        className="repo-row repo-row-archived"
        draggable
        onDragStart={(e) => handleDragStart(e, repo)}
        onDragEnd={handleDragEnd}
        onDragEnter={(e) => handleDragOver(e, repo)}
        onDragOver={(e) => handleDragOver(e, repo)}
        onDrop={(e) => handleDrop(e, repo)}
        onContextMenu={(e) => openMenu(e, repo)}
      >
        <span className="repo-name" title={repo.path}>
          {repo.name}
        </span>
        <span className="repo-actions">
          <button
            className="icon-btn"
            title={t('sidebar.unarchive')}
            draggable={false}
            onClick={() => void unarchiveRepo(repo)}
          >
            ↺
          </button>
        </span>
      </div>
    </div>
  );

  // ルートは <aside> ではなく <div>: P8-2 以降はランドマークとしての <aside> を
  // Rail が持ち、Sidebar はその中のリポジトリーナビ部分になった。
  return (
    <div className="sidebar">
      <div className="sidebar-head">
        <span>{t('sidebar.repositories')}</span>
        <button className="icon-btn" onClick={() => void addRepo()} title={t('sidebar.addRepo')}>
          ＋
        </button>
      </div>
      <div className="sidebar-list">
        {repos.length === 0 && (
          <div className="sidebar-empty">
            {t('sidebar.empty')
              .split('\n')
              .map((line, i) => (
                <span key={i}>
                  {i > 0 && <br />}
                  {line}
                </span>
              ))}
          </div>
        )}
        {pinned.length > 0 && (
          <>
            <div className="sidebar-section-head">{t('sidebar.pinned')}</div>
            {pinned.map(renderActiveRow)}
          </>
        )}
        {normal.length > 0 && (
          <div className={`sidebar-section-normal${pinned.length > 0 ? ' divider' : ''}`}>
            {normal.map(renderActiveRow)}
          </div>
        )}
        {archived.length > 0 && (
          <div className="sidebar-section-archived">
            <button className="sidebar-section-head sidebar-section-toggle" onClick={toggleArchivedOpen}>
              <span className={`codicon codicon-chevron-${archivedOpen ? 'down' : 'right'}`} />
              {t('sidebar.archived', { n: archived.length })}
            </button>
            {archivedOpen && archived.map(renderArchivedRow)}
          </div>
        )}
      </div>
      {worktreeTarget && (
        <AddWorktreeModal repo={worktreeTarget} onClose={() => setWorktreeTarget(null)} />
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.repo)} onClose={() => setMenu(null)} />
      )}
      {dialog}
      {promptDlg}
    </div>
  );
}
