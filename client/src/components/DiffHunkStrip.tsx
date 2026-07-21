import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { HUNK_CONFLICT_MESSAGE, hunkStats } from '../diffHunk';
import { useDeck } from '../store';
import type { DiffHunk } from '../types';
import { useConfirm } from './ConfirmDialog';

/**
 * DiffPane 内に載せる、ハンク単位の stage / unstage / discard 操作帯。
 * scope='worktree' | 'staged' のときだけ DiffPane から描画される
 * (scope='commit' と untracked ファイルの合成 diff は呼び出し側で除外済み)。
 */
export default function DiffHunkStrip({
  dir,
  path,
  scope,
  onApplied,
  onHunkStateChanged,
  onReveal,
}: {
  dir: string;
  path: string;
  scope: 'worktree' | 'staged';
  /** stage/unstage/discard 適用後、diff 本体 (DiffPane 側の pair) を取り直させる */
  onApplied: () => void;
  /**
   * git の実状態が実際に変わった (= 409 ではなく適用成功した) ときだけ呼ばれる。
   * 同じファイルを別スコープ (staged/worktree) で開いている兄弟タブへ、
   * 再読込が必要なことを知らせるために使う (省略可)。
   */
  onHunkStateChanged?: () => void;
  /** ハンク行クリック時、Monaco 側をその位置へスクロールさせる (省略可) */
  onReveal?: (hunk: DiffHunk) => void;
}) {
  const refreshDeck = useDeck((s) => s.refresh);
  const { confirm: confirmDialog, dialog } = useConfirm();
  const [hunks, setHunks] = useState<DiffHunk[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      const result = await api.diffHunks(dir, path, scope);
      setHunks(result.hunks);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [dir, path, scope]);

  useEffect(() => {
    setHunks(null);
    setError('');
    setNotice('');
    void load();
  }, [load]);

  const apply = async (index: number, applyScope: 'stage' | 'unstage' | 'discard') => {
    if (!hunks || busy) return;
    setBusy(true);
    setNotice('');
    try {
      await api.applyHunks(dir, path, applyScope, [index], hunks.length, [hunks[index].header]);
      await load();
      onApplied();
      onHunkStateChanged?.();
      void refreshDeck();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === HUNK_CONFLICT_MESSAGE) {
        // 409: 操作は適用されていない。差分とハンク一覧を取り直すだけで、破棄確認等はやり直させる。
        setNotice('差分が変化したため再読み込みしました');
        await load();
        onApplied();
      } else {
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  };

  const discard = async (index: number, hunk: DiffHunk) => {
    const ok = await confirmDialog({
      title: 'ハンクを破棄',
      message: `この変更を破棄しますか?\n${hunk.header}\n\n※ 元に戻せません`,
      confirmLabel: '破棄',
      severity: 'danger',
    });
    if (!ok) return;
    void apply(index, 'discard');
  };

  if (error) {
    return (
      <div className="hunk-strip">
        <div className="hunk-strip-notice hunk-strip-error">⚠ {error}</div>
        {dialog}
      </div>
    );
  }
  // 読み込み中や差分なし (0 ハンク) は帯そのものを出さない。
  if (!hunks || hunks.length === 0) return null;

  return (
    <div className="hunk-strip">
      {notice && <div className="hunk-strip-notice">{notice}</div>}
      <div className="hunk-strip-list">
        {hunks.map((hunk, index) => {
          const { added, removed } = hunkStats(hunk);
          return (
            <div key={index} className="hunk-chip">
              <button
                className="hunk-chip-loc"
                title="この位置へスクロール"
                onClick={() => onReveal?.(hunk)}
              >
                {hunk.header}
              </button>
              <span className="hunk-chip-stat">
                {added > 0 && <span className="hunk-add">+{added}</span>}
                {removed > 0 && <span className="hunk-del">-{removed}</span>}
              </span>
              <span className="hunk-chip-actions">
                {scope === 'worktree' && (
                  <>
                    <button
                      className="icon-btn"
                      disabled={busy}
                      title="このハンクをステージ"
                      onClick={() => void apply(index, 'stage')}
                    >
                      <span className="codicon codicon-add" />
                    </button>
                    <button
                      className="icon-btn"
                      disabled={busy}
                      title="このハンクを破棄"
                      onClick={() => void discard(index, hunk)}
                    >
                      <span className="codicon codicon-discard" />
                    </button>
                  </>
                )}
                {scope === 'staged' && (
                  <button
                    className="icon-btn"
                    disabled={busy}
                    title="このハンクをステージ解除"
                    onClick={() => void apply(index, 'unstage')}
                  >
                    <span className="codicon codicon-remove" />
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>
      {dialog}
    </div>
  );
}
