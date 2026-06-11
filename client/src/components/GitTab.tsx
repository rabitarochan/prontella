import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useDeck } from '../store';
import type { BranchInfo, Repo, StashEntry, Worktree } from '../types';
import ChangesTab from './ChangesTab';
import HistoryTab from './HistoryTab';

type GitView = 'status' | 'history';

const POLL_MS = 10_000;

export default function GitTab({ repo, worktree }: { repo: Repo; worktree: Worktree }) {
  const refreshDeck = useDeck((s) => s.refresh);
  const [view, setView] = useState<GitView>('status');
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [stashes, setStashes] = useState<StashEntry[]>([]);
  const [openLocal, setOpenLocal] = useState(true);
  const [openRemote, setOpenRemote] = useState(false);
  const [openStash, setOpenStash] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  const dir = worktree.path;
  const currentBranch = worktree.branch;

  const load = useCallback(() => {
    api.branches(repo.id).then(setBranches).catch(() => {});
    api.stashList(dir).then(setStashes).catch(() => {});
  }, [repo.id, dir]);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const act = async (fn: () => Promise<unknown>, successMsg?: string) => {
    setBusy(true);
    setMessage('');
    try {
      await fn();
      load();
      await refreshDeck();
      setReloadKey((k) => k + 1); // force changes/history views to refetch
      if (successMsg) setMessage(`✓ ${successMsg}`);
    } catch (e) {
      setMessage(`⚠ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const createBranch = () => {
    const name = prompt('新しいブランチ名 (現在の HEAD から作成して切り替え):');
    if (!name?.trim()) return;
    void act(() => api.switchBranch(dir, name.trim(), true), `${name.trim()} を作成しました`);
  };

  const stashCurrent = () => {
    const msg = prompt('スタッシュのメッセージ (省略可):');
    if (msg === null) return;
    void act(() => api.stashPush(dir, msg || undefined), 'スタッシュしました');
  };

  const deleteBranch = (branch: string) => {
    if (!confirm(`ブランチ ${branch} を削除しますか?`)) return;
    void act(async () => {
      try {
        await api.deleteBranch(dir, branch);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (confirm(`削除に失敗しました:\n${msg}\n\nマージされていないコミットごと強制削除しますか?`)) {
          await api.deleteBranch(dir, branch, true);
        } else {
          throw e;
        }
      }
    }, 'ブランチを削除しました');
  };

  const locals = branches.filter((b) => !b.remote);
  const remotes = branches.filter((b) => b.remote);
  const dirty =
    (worktree.status?.staged ?? 0) +
    (worktree.status?.unstaged ?? 0) +
    (worktree.status?.untracked ?? 0);

  const sectionHead = (
    title: string,
    open: boolean,
    toggle: () => void,
    action?: { icon: string; title: string; onClick: () => void },
  ) => (
    <div className="git-section-head" onClick={toggle}>
      <span>
        <span className={`codicon codicon-chevron-${open ? 'down' : 'right'}`} /> {title}
      </span>
      {action && (
        <button
          className="icon-btn"
          title={action.title}
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            action.onClick();
          }}
        >
          <span className={`codicon codicon-${action.icon}`} />
        </button>
      )}
    </div>
  );

  return (
    <div className="git-tab">
      <div className="git-side">
        <div className="git-section-head git-section-title">ワークスペース</div>
        <div
          className={`git-nav-row ${view === 'status' ? 'active' : ''}`}
          onClick={() => setView('status')}
        >
          <span className="codicon codicon-diff-multiple" /> ファイルステータス
          {dirty > 0 && <span className="wt-dirty">{dirty}</span>}
        </div>
        <div
          className={`git-nav-row ${view === 'history' ? 'active' : ''}`}
          onClick={() => setView('history')}
        >
          <span className="codicon codicon-history" /> 履歴
        </div>

        {sectionHead('ブランチ', openLocal, () => setOpenLocal((v) => !v), {
          icon: 'add',
          title: '新しいブランチを作成',
          onClick: createBranch,
        })}
        {openLocal &&
          locals.map((b) => {
            const isCurrent = b.name === currentBranch;
            const usedElsewhere =
              !!b.worktreePath && b.worktreePath !== worktree.path.replace(/\\/g, '/');
            return (
              <div key={b.name} className={`git-branch-row ${isCurrent ? 'current' : ''}`} title={b.name}>
                <span className="codicon codicon-git-branch branch-icon" />
                <span className="branch-name">
                  {b.name}
                  {usedElsewhere && <span className="branch-used-mark" title="他の Worktree で使用中"> ◈</span>}
                </span>
                {isCurrent ? (
                  <span className="branch-current-mark">✓</span>
                ) : (
                  <span className="branch-actions">
                    <button
                      className="icon-btn"
                      title="切り替え"
                      disabled={busy || usedElsewhere}
                      onClick={() =>
                        void act(() => api.switchBranch(dir, b.name), `${b.name} に切り替えました`)
                      }
                    >
                      <span className="codicon codicon-arrow-swap" />
                    </button>
                    <button
                      className="icon-btn"
                      title={`${b.name} を ${currentBranch ?? 'HEAD'} にマージ`}
                      disabled={busy}
                      onClick={() => {
                        if (confirm(`${b.name} を ${currentBranch ?? '現在のブランチ'} にマージしますか?`)) {
                          void act(() => api.merge(dir, b.name), 'マージしました');
                        }
                      }}
                    >
                      <span className="codicon codicon-git-merge" />
                    </button>
                    <button
                      className="icon-btn"
                      title="削除"
                      disabled={busy || usedElsewhere}
                      onClick={() => deleteBranch(b.name)}
                    >
                      <span className="codicon codicon-trash" />
                    </button>
                  </span>
                )}
              </div>
            );
          })}

        {sectionHead('リモート', openRemote, () => setOpenRemote((v) => !v))}
        {openRemote &&
          (remotes.length === 0 ? (
            <div className="git-side-empty">リモートブランチはありません</div>
          ) : (
            remotes.map((b) => (
              <div key={b.name} className="git-branch-row" title={b.name}>
                <span className="codicon codicon-cloud branch-icon" />
                <span className="branch-name">{b.name}</span>
              </div>
            ))
          ))}

        {sectionHead('スタッシュ', openStash, () => setOpenStash((v) => !v), {
          icon: 'archive',
          title: '現在の変更をスタッシュ (未追跡ファイル含む)',
          onClick: stashCurrent,
        })}
        {openStash &&
          (stashes.length === 0 ? (
            <div className="git-side-empty">スタッシュはありません</div>
          ) : (
            stashes.map((s) => (
              <div key={s.ref} className="git-branch-row" title={`${s.ref}: ${s.message}`}>
                <span className="codicon codicon-archive branch-icon" />
                <span className="branch-name">{s.message}</span>
                <span className="branch-actions">
                  <button
                    className="icon-btn"
                    title="適用して削除 (pop)"
                    disabled={busy}
                    onClick={() => void act(() => api.stashApply(dir, s.ref, true), '適用しました')}
                  >
                    <span className="codicon codicon-debug-step-out" />
                  </button>
                  <button
                    className="icon-btn"
                    title="適用 (スタッシュは残す)"
                    disabled={busy}
                    onClick={() => void act(() => api.stashApply(dir, s.ref, false), '適用しました')}
                  >
                    <span className="codicon codicon-desktop-download" />
                  </button>
                  <button
                    className="icon-btn"
                    title="削除"
                    disabled={busy}
                    onClick={() => {
                      if (confirm(`${s.ref} を削除しますか?\n${s.message}`)) {
                        void act(() => api.stashDrop(dir, s.ref), '削除しました');
                      }
                    }}
                  >
                    <span className="codicon codicon-trash" />
                  </button>
                </span>
              </div>
            ))
          ))}

        {message && <div className="git-side-msg">{message}</div>}
      </div>
      <div className="git-main">
        {view === 'status' ? (
          <ChangesTab key={`s${reloadKey}`} dir={dir} />
        ) : (
          <HistoryTab key={`h${reloadKey}`} dir={dir} />
        )}
      </div>
    </div>
  );
}
