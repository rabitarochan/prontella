import { useEffect, useState } from 'react';
import { api } from '../api';
import { useDeck } from '../store';
import type { BranchInfo, Repo } from '../types';

export default function AddWorktreeModal({ repo, onClose }: { repo: Repo; onClose: () => void }) {
  const refresh = useDeck((s) => s.refresh);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [mode, setMode] = useState<'existing' | 'new'>('new');
  const [branch, setBranch] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [base, setBase] = useState('');
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .branches(repo.id)
      .then((list) => {
        setBranches(list);
        const current = list.find((b) => b.current);
        if (current) setBase(current.name);
        const available = list.find((b) => !b.remote && !b.worktreePath);
        if (available) setBranch(available.name);
      })
      .catch((e: Error) => setError(e.message));
  }, [repo.id]);

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await api.addWorktree(repo.id, {
        branch: mode === 'existing' ? branch : undefined,
        newBranch: mode === 'new' ? newBranch.trim() : undefined,
        base: mode === 'new' && base ? base : undefined,
        path: path.trim() || undefined,
      });
      await refresh();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const locals = branches.filter((b) => !b.remote);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Worktree を追加 — {repo.name}</h3>
        <div className="modal-row">
          <label>
            <input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} />
            新しいブランチを作成
          </label>
          <label>
            <input type="radio" checked={mode === 'existing'} onChange={() => setMode('existing')} />
            既存のブランチ
          </label>
        </div>
        {mode === 'new' ? (
          <>
            <div className="modal-row">
              <label className="modal-label">ブランチ名</label>
              <input
                value={newBranch}
                onChange={(e) => setNewBranch(e.target.value)}
                placeholder="feature/awesome"
                autoFocus
              />
            </div>
            <div className="modal-row">
              <label className="modal-label">作成元 (base)</label>
              <select value={base} onChange={(e) => setBase(e.target.value)}>
                {branches.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          </>
        ) : (
          <div className="modal-row">
            <label className="modal-label">ブランチ</label>
            <select value={branch} onChange={(e) => setBranch(e.target.value)}>
              {locals.map((b) => (
                <option key={b.name} value={b.name} disabled={!!b.worktreePath}>
                  {b.name}
                  {b.worktreePath ? ' (使用中)' : ''}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="modal-row">
          <label className="modal-label">パス (省略可)</label>
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={`既定: ../${repo.name}.worktrees/<ブランチ名>`}
          />
        </div>
        {error && <div className="modal-error">⚠ {error}</div>}
        <div className="modal-actions">
          <button onClick={onClose}>キャンセル</button>
          <button
            className="primary"
            disabled={busy || (mode === 'new' ? !newBranch.trim() : !branch)}
            onClick={() => void submit()}
          >
            {busy ? '作成中...' : '作成'}
          </button>
        </div>
      </div>
    </div>
  );
}
