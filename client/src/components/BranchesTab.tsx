import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useDeck } from '../store';
import type { BranchInfo, Worktree } from '../types';

export default function BranchesTab({ repoId, worktree }: { repoId: string; worktree: Worktree }) {
  const refreshDeck = useDeck((s) => s.refresh);
  const [branches, setBranches] = useState<BranchInfo[] | null>(null);
  const [showRemote, setShowRemote] = useState(false);
  const [newBranch, setNewBranch] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const dir = worktree.path;

  const load = useCallback(() => {
    api
      .branches(repoId)
      .then(setBranches)
      .catch((e: Error) => setMessage(`⚠ ${e.message}`));
  }, [repoId]);

  useEffect(load, [load]);

  const act = async (fn: () => Promise<unknown>, successMsg?: string) => {
    setBusy(true);
    setMessage('');
    try {
      const result = await fn();
      load();
      await refreshDeck();
      const text = typeof result === 'object' && result && 'result' in result
        ? String((result as { result: string }).result).trim().split('\n').pop()
        : undefined;
      if (successMsg || text) setMessage(`✓ ${successMsg ?? ''}${text ? ` ${text}` : ''}`);
    } catch (e) {
      setMessage(`⚠ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  if (branches === null) return <div className="placeholder">{message || '読み込み中...'}</div>;

  const visible = branches.filter((b) => showRemote || !b.remote);
  const currentBranch = worktree.branch;

  return (
    <div className="branches-tab">
      <div className="branches-toolbar">
        <input
          placeholder="新しいブランチ名 (現在の HEAD から作成して切り替え)"
          value={newBranch}
          onChange={(e) => setNewBranch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && newBranch.trim()) {
              void act(() => api.switchBranch(dir, newBranch.trim(), true), 'ブランチを作成しました');
              setNewBranch('');
            }
          }}
        />
        <button
          disabled={busy || !newBranch.trim()}
          onClick={() => {
            void act(() => api.switchBranch(dir, newBranch.trim(), true), 'ブランチを作成しました');
            setNewBranch('');
          }}
        >
          ＋ 作成
        </button>
        <label className="branches-remote-toggle">
          <input type="checkbox" checked={showRemote} onChange={(e) => setShowRemote(e.target.checked)} />
          リモートを表示
        </label>
        {message && <span className="branches-msg">{message}</span>}
      </div>
      <div className="branches-list">
        {visible.map((b) => {
          const isCurrent = !b.remote && b.name === currentBranch;
          const usedElsewhere = !!b.worktreePath && b.worktreePath !== worktree.path.replace(/\\/g, '/');
          return (
            <div key={(b.remote ? 'r:' : 'l:') + b.name} className={`branch-row ${isCurrent ? 'current' : ''}`}>
              <span
                className={`codicon codicon-${b.remote ? 'cloud' : 'git-branch'} branch-icon`}
              />
              <span className="branch-name" title={b.name}>
                {b.name}
                {isCurrent && <span className="branch-current-mark"> ✓ 現在</span>}
                {usedElsewhere && <span className="branch-used-mark"> (他の Worktree で使用中)</span>}
              </span>
              <span className="branch-hash">{b.hash}</span>
              {!b.remote && !isCurrent && (
                <span className="branch-actions">
                  <button
                    className="icon-btn"
                    title="このブランチに切り替え"
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
                        void act(() => api.merge(dir, b.name));
                      }
                    }}
                  >
                    <span className="codicon codicon-git-merge" />
                  </button>
                  <button
                    className="icon-btn"
                    title="ブランチを削除"
                    disabled={busy || usedElsewhere}
                    onClick={() => {
                      if (!confirm(`ブランチ ${b.name} を削除しますか?`)) return;
                      void act(async () => {
                        try {
                          await api.deleteBranch(dir, b.name);
                        } catch (e) {
                          const msg = e instanceof Error ? e.message : String(e);
                          if (confirm(`削除に失敗しました:\n${msg}\n\nマージされていないコミットごと強制削除しますか?`)) {
                            await api.deleteBranch(dir, b.name, true);
                          } else {
                            throw e;
                          }
                        }
                      }, 'ブランチを削除しました');
                    }}
                  >
                    <span className="codicon codicon-trash" />
                  </button>
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
