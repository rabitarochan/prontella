import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { useDeck } from '../store';
import type { StatusFile } from '../types';
import { useConfirm } from './ConfirmDialog';

const POLL_MS = 5000;

export default function ChangesTab({
  dir,
  onOpenDiff,
  onOpenConflict,
  selectedKey,
  visible,
}: {
  dir: string;
  onOpenDiff: (file: StatusFile, staged: boolean) => void;
  /** 競合ファイル (StatusFile.conflicted) の行クリック用。差分ではなく解決ペインを開く。 */
  onOpenConflict: (file: StatusFile) => void;
  /** アクティブな diff/競合タブのキー (`s:`/`w:`/`c:` + path) — 行のハイライト用 */
  selectedKey?: string | null;
  /** このタブが現在表示中かどうか。非表示中はポーリングを止める。 */
  visible: boolean;
}) {
  const t = useT();
  const refreshDeck = useDeck((s) => s.refresh);
  const { confirm: confirmDialog, dialog } = useConfirm();
  // discardAll の confirm ダイアログ内チェックボックス state。ReactNode として一度きり
  // 生成される message の中では useState の checked が再レンダー無しに追従しないため、
  // 呼び出し側の ref で最新値を保持し、確定時に読み出す。
  const discardUntrackedRef = useRef(false);
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
    // タブが非表示の間はポーリングしない。visible が false→true になった瞬間も
    // この effect が再実行されるので、即 load() してから interval を張り直す形になる。
    if (!visible) return;
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load, visible]);

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

  const discard = async (file: StatusFile) => {
    const ok = await confirmDialog({
      title: file.untracked ? t('changes.discardUntrackedTitle') : t('changes.discardTrackedTitle'),
      message: file.untracked
        ? t('changes.discardUntrackedMessage', { path: file.path })
        : t('changes.discardTrackedMessage', { path: file.path }),
      confirmLabel: t('git.discard'),
      severity: 'danger',
    });
    if (!ok) return;
    void act(() => api.discard(dir, file.path, file.untracked));
  };

  const undoLastCommit = async () => {
    let lastCommitLine = '';
    try {
      const [last] = await api.log(dir, 1);
      if (last) lastCommitLine = t('changes.lastCommitLine', { hash: last.shortHash, subject: last.subject });
    } catch {
      // 取得できなくても確認自体は続行する
    }
    const ok = await confirmDialog({
      title: t('changes.undoLastCommitTitle'),
      message: t('changes.undoLastCommitMessage', { lastCommitLine }),
      confirmLabel: t('changes.undoConfirm'),
      severity: 'normal',
    });
    if (!ok) return;
    void act(() => api.undoLastCommit(dir));
  };

  const discardAllChanges = async () => {
    const trackedCount = unstagedFiles.filter((f) => !f.untracked).length;
    const untrackedCount = unstagedFiles.filter((f) => f.untracked).length;
    discardUntrackedRef.current = false;
    const ok = await confirmDialog({
      title: t('changes.discardAllTitle'),
      message: (
        <>
          <div>{t('changes.discardAllMessage', { n: trackedCount })}</div>
          <label className="amend-toggle">
            <input
              type="checkbox"
              defaultChecked={false}
              onChange={(e) => {
                discardUntrackedRef.current = e.target.checked;
              }}
            />
            {t('changes.discardAllUntrackedToggle', { n: untrackedCount })}
          </label>
          <div>{t('git.cannotUndo')}</div>
        </>
      ),
      confirmLabel: t('git.discard'),
      severity: 'danger',
    });
    if (!ok) return;
    void act(() => api.discardAll(dir, discardUntrackedRef.current));
  };

  const fileRow = (file: StatusFile, staged: boolean) => (
    <div
      key={`${staged}-${file.path}`}
      className={`change-row ${
        selectedKey === (file.conflicted ? `c:${file.path}` : `${staged ? 's' : 'w'}:${file.path}`)
          ? 'selected'
          : ''
      }`}
      onClick={() => (file.conflicted ? onOpenConflict(file) : onOpenDiff(file, staged))}
      title={
        file.conflicted
          ? t('changes.conflictRowTooltip', { path: file.path })
          : t('changes.diffRowTooltip', { path: file.path })
      }
    >
      <span
        className={`change-mark mark-${file.conflicted ? 'U' : staged ? file.staged : file.untracked ? 'A' : file.unstaged}`}
      >
        {file.conflicted ? 'U' : staged ? file.staged : file.untracked ? '?' : file.unstaged}
      </span>
      <span className="change-path">&lrm;{file.path}&lrm;</span>
      <span className="change-actions">
        {!staged && (
          <button
            className="icon-btn"
            disabled={busy}
            title={file.untracked ? t('changes.deleteFileTooltip') : t('changes.discardChangeTooltip')}
            onClick={(e) => {
              e.stopPropagation();
              void discard(file);
            }}
          >
            <span className="codicon codicon-discard" />
          </button>
        )}
        {!file.conflicted && (
          <button
            className="icon-btn"
            disabled={busy}
            title={staged ? t('changes.unstageTooltip') : t('changes.stageTooltip')}
            onClick={(e) => {
              e.stopPropagation();
              void act(() => (staged ? api.unstage(dir, file.path) : api.stage(dir, file.path)));
            }}
          >
            <span className={`codicon codicon-${staged ? 'remove' : 'add'}`} />
          </button>
        )}
      </span>
    </div>
  );

  return (
    <div className="changes-pane">
      <div className="changes-list">
        {error && <div className="my-2 text-xs whitespace-pre-wrap text-[var(--status-red)]">⚠ {error}</div>}
        <div className="changes-section">
          <div className="changes-section-head">
            <span>{t('changes.stagedSectionTitle', { n: stagedFiles.length })}</span>
            {stagedFiles.length > 0 && (
              <button
                className="icon-btn"
                disabled={busy}
                title={t('changes.unstageAllTooltip')}
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
            <span>{t('changes.unstagedSectionTitle', { n: unstagedFiles.length })}</span>
            {unstagedFiles.length > 0 && (
              <span className="changes-section-actions">
                <button
                  className="icon-btn"
                  disabled={busy}
                  title={t('changes.discardAllTooltip')}
                  onClick={() => void discardAllChanges()}
                >
                  <span className="codicon codicon-trash" />
                </button>
                <button
                  className="icon-btn"
                  disabled={busy}
                  title={t('changes.stageAllTooltip')}
                  onClick={() => void act(() => api.stageAll(dir))}
                >
                  <span className="codicon codicon-add" />
                </button>
              </span>
            )}
          </div>
          {unstagedFiles.map((f) => fileRow(f, false))}
        </div>
        {files.length === 0 && !merging && <div className="placeholder">{t('changes.empty')}</div>}
        <div className="commit-box">
          <textarea
            placeholder={t('changes.commitMessagePlaceholder')}
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            rows={3}
          />
          <label className="amend-toggle">
            <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} />
            {t('changes.amendToggle')}
          </label>
          <button disabled={busy} onClick={() => void undoLastCommit()}>
            {t('changes.undoLastCommitTitle')}
          </button>
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
            {amend ? t('changes.amendCommitButton') : t('changes.commitButton', { n: stagedFiles.length })}
          </button>
        </div>
      </div>
      {dialog}
    </div>
  );
}
