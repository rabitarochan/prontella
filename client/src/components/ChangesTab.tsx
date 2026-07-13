import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useDeck } from '../store';
import type { StatusFile } from '../types';

const POLL_MS = 5000;

export default function ChangesTab({
  dir,
  onOpenDiff,
  selectedKey,
}: {
  dir: string;
  onOpenDiff: (file: StatusFile, staged: boolean) => void;
  /** アクティブな diff タブのキー (`s:` / `w:` + path) — 行のハイライト用 */
  selectedKey?: string | null;
}) {
  const refreshDeck = useDeck((s) => s.refresh);
  const [files, setFiles] = useState<StatusFile[]>([]);
  const [merging, setMerging] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const status = await api.gitStatus(dir);
      setFiles(status.files);
      setMerging(status.merging);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [dir]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const stagedFiles = files.filter((f) => f.staged !== '.' && f.staged !== '?' && !f.conflicted);
  const unstagedFiles = files.filter((f) => f.unstaged !== '.' || f.untracked || f.conflicted);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await load();
      await refreshDeck();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const discard = (file: StatusFile) => {
    const what = file.untracked ? 'この未追跡ファイルを削除' : 'この変更を破棄';
    if (!confirm(`${what}しますか?\n${file.path}\n\n※ 元に戻せません`)) return;
    void act(() => api.discard(dir, file.path, file.untracked));
  };

  const fileRow = (file: StatusFile, staged: boolean) => (
    <div
      key={`${staged}-${file.path}`}
      className={`change-row ${selectedKey === `${staged ? 's' : 'w'}:${file.path}` ? 'selected' : ''}`}
      onClick={() => onOpenDiff(file, staged)}
      title={`${file.path} — クリックで差分をタブ表示`}
    >
      <span
        className={`change-mark mark-${file.conflicted ? 'U' : staged ? file.staged : file.untracked ? 'A' : file.unstaged}`}
      >
        {file.conflicted ? 'U' : staged ? file.staged : file.untracked ? '?' : file.unstaged}
      </span>
      <span className="change-path">{file.path}</span>
      <span className="change-actions">
        {!staged && (
          <button
            className="icon-btn"
            disabled={busy}
            title={file.untracked ? 'ファイルを削除' : '変更を破棄'}
            onClick={(e) => {
              e.stopPropagation();
              discard(file);
            }}
          >
            <span className="codicon codicon-discard" />
          </button>
        )}
        <button
          className="icon-btn"
          disabled={busy}
          title={staged ? 'ステージ解除' : 'ステージ'}
          onClick={(e) => {
            e.stopPropagation();
            void act(() => (staged ? api.unstage(dir, file.path) : api.stage(dir, file.path)));
          }}
        >
          <span className={`codicon codicon-${staged ? 'remove' : 'add'}`} />
        </button>
      </span>
    </div>
  );

  return (
    <div className="changes-pane">
      <div className="changes-list">
        {error && <div className="modal-error">⚠ {error}</div>}
        {merging && (
          <div className="merge-banner">
            <span>⚠ マージ進行中 (コンフリクトを解決してコミット)</span>
            <button
              disabled={busy}
              onClick={() => {
                if (confirm('マージを中止して元の状態に戻しますか?')) {
                  void act(() => api.mergeAbort(dir));
                }
              }}
            >
              マージ中止
            </button>
          </div>
        )}
        <div className="changes-section">
          <div className="changes-section-head">
            <span>ステージ済み ({stagedFiles.length})</span>
            {stagedFiles.length > 0 && (
              <button
                className="icon-btn"
                disabled={busy}
                title="すべてステージ解除"
                onClick={() => void act(() => api.unstageAll(dir))}
              >
                <span className="codicon codicon-remove" />
              </button>
            )}
          </div>
          {stagedFiles.map((f) => fileRow(f, true))}
        </div>
        <div className="changes-section">
          <div className="changes-section-head">
            <span>変更 ({unstagedFiles.length})</span>
            {unstagedFiles.length > 0 && (
              <button
                className="icon-btn"
                disabled={busy}
                title="すべてステージ"
                onClick={() => void act(() => api.stageAll(dir))}
              >
                <span className="codicon codicon-add" />
              </button>
            )}
          </div>
          {unstagedFiles.map((f) => fileRow(f, false))}
        </div>
        {files.length === 0 && !merging && <div className="placeholder">変更はありません</div>}
        <div className="commit-box">
          <textarea
            placeholder="コミットメッセージ"
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            rows={3}
          />
          <label className="amend-toggle">
            <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} />
            直前のコミットを修正 (--amend)
          </label>
          <button
            className="primary"
            disabled={busy || !commitMsg.trim() || (stagedFiles.length === 0 && !amend)}
            onClick={() =>
              void act(async () => {
                await api.commit(dir, commitMsg.trim(), amend);
                setCommitMsg('');
                setAmend(false);
              })
            }
          >
            {amend ? 'コミットを修正' : `コミット (${stagedFiles.length} ファイル)`}
          </button>
        </div>
      </div>
    </div>
  );
}
