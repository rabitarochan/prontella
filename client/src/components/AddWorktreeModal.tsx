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
import { useT } from '../i18n';
import { useDeck } from '../store';
import type { ActiveRepo, BranchInfo } from '../types';

export default function AddWorktreeModal({ repo, onClose }: { repo: ActiveRepo; onClose: () => void }) {
  const t = useT();
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
          <DialogTitle>{t('addWorktree.title', { name: repo.name })}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="flex items-center gap-5 text-sm">
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} />
              {t('addWorktree.newBranchOption')}
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={mode === 'existing'} onChange={() => setMode('existing')} />
              {t('addWorktree.existingBranchOption')}
            </label>
          </div>
          {mode === 'new' ? (
            <>
              <div className="grid grid-cols-[110px_1fr] items-center gap-3">
                <Label htmlFor="wt-new-branch">{t('addWorktree.branchNameLabel')}</Label>
                <Input
                  id="wt-new-branch"
                  ref={branchInputRef}
                  value={newBranch}
                  onChange={(e) => setNewBranch(e.target.value)}
                  placeholder="feature/awesome"
                />
              </div>
              <div className="grid grid-cols-[110px_1fr] items-center gap-3">
                <Label htmlFor="wt-base">{t('addWorktree.baseLabel')}</Label>
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
              <Label htmlFor="wt-branch">{t('addWorktree.branchLabel')}</Label>
              <select id="wt-branch" value={branch} onChange={(e) => setBranch(e.target.value)}>
                {locals.map((b) => (
                  <option key={b.name} value={b.name} disabled={!!b.worktreePath}>
                    {b.name}
                    {b.worktreePath ? t('addWorktree.inUseSuffix') : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="grid grid-cols-[110px_1fr] items-center gap-3">
            <Label htmlFor="wt-path">{t('addWorktree.pathLabel')}</Label>
            <Input
              id="wt-path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder={t('addWorktree.pathPlaceholder', { name: repo.name })}
            />
          </div>
          {error && <div className="text-sm text-[var(--status-red)]">⚠ {error}</div>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={busy || (mode === 'new' ? !newBranch.trim() : !branch)}
            onClick={() => void submit()}
          >
            {busy ? t('addWorktree.creating') : t('git.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
