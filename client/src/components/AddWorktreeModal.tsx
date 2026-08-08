import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '../api';
import { useDeck } from '../store';
import type { ActiveRepo, BranchInfo } from '../types';

export default function AddWorktreeModal({ repo, onClose }: { repo: ActiveRepo; onClose: () => void }) {
  const refresh = useDeck((s) => s.refresh);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [mode, setMode] = useState<'existing' | 'new'>('new');
  const [branch, setBranch] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [base, setBase] = useState('');
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const branchInputRef = useRef<HTMLInputElement>(null);

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
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          branchInputRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Worktree を追加 — {repo.name}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="flex items-center gap-5 text-sm">
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} />
              新しいブランチを作成
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={mode === 'existing'} onChange={() => setMode('existing')} />
              既存のブランチ
            </label>
          </div>
          {mode === 'new' ? (
            <>
              <div className="grid grid-cols-[110px_1fr] items-center gap-3">
                <Label htmlFor="wt-new-branch">ブランチ名</Label>
                <Input
                  id="wt-new-branch"
                  ref={branchInputRef}
                  value={newBranch}
                  onChange={(e) => setNewBranch(e.target.value)}
                  placeholder="feature/awesome"
                />
              </div>
              <div className="grid grid-cols-[110px_1fr] items-center gap-3">
                <Label htmlFor="wt-base">作成元 (base)</Label>
                <select id="wt-base" value={base} onChange={(e) => setBase(e.target.value)}>
                  {branches.map((b) => (
                    <option key={b.name} value={b.name}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </div>
            </>
          ) : (
            <div className="grid grid-cols-[110px_1fr] items-center gap-3">
              <Label htmlFor="wt-branch">ブランチ</Label>
              <select id="wt-branch" value={branch} onChange={(e) => setBranch(e.target.value)}>
                {locals.map((b) => (
                  <option key={b.name} value={b.name} disabled={!!b.worktreePath}>
                    {b.name}
                    {b.worktreePath ? ' (使用中)' : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="grid grid-cols-[110px_1fr] items-center gap-3">
            <Label htmlFor="wt-path">パス (省略可)</Label>
            <Input
              id="wt-path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder={`既定: ../${repo.name}.worktrees/<ブランチ名>`}
            />
          </div>
          {error && <div className="text-sm text-[var(--status-red)]">⚠ {error}</div>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            キャンセル
          </Button>
          <Button
            disabled={busy || (mode === 'new' ? !newBranch.trim() : !branch)}
            onClick={() => void submit()}
          >
            {busy ? '作成中...' : '作成'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
