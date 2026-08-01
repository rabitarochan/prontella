import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
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
    const what = file.untracked ? 'この未追跡ファイルを削除' : 'この変更を破棄';
    const ok = await confirmDialog({
      title: what,
      message: `${what}しますか?\n${file.path}\n\n※ 元に戻せません`,
      confirmLabel: '破棄',
      severity: 'danger',
    });
    if (!ok) return;
    void act(() => api.discard(dir, file.path, file.untracked));
  };

  const undoLastCommit = async () => {
    let lastCommitLine = '';
    try {
      const [last] = await api.log(dir, 1);
      if (last) lastCommitLine = `\n\n直前のコミット: ${last.shortHash} ${last.subject}`;
    } catch {
      // 取得できなくても確認自体は続行する
    }
    const ok = await confirmDialog({
      title: '直前のコミットを取り消す',
      message: `直前のコミットを取り消しますか?(reset --soft HEAD~1)\n変更はステージ済みとして残ります。${lastCommitLine}`,
      confirmLabel: '取り消す',
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
      title: 'すべての変更を破棄',
      message: (
        <>
          <div>変更ファイル {trackedCount} 件の作業ツリーの変更を破棄します。</div>
          <label className="amend-toggle">
            <input
              type="checkbox"
              defaultChecked={false}
              onChange={(e) => {
                discardUntrackedRef.current = e.target.checked;
              }}
            />
            未追跡ファイルも削除する ({untrackedCount} 件)
          </label>
          <div>※ 元に戻せません</div>
        </>
      ),
      confirmLabel: '破棄',
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
      title={file.conflicted ? `${file.path} — クリックで競合を解決` : `${file.path} — クリックで差分をタブ表示`}
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
            title={file.untracked ? 'ファイルを削除' : '変更を破棄'}
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
            title={staged ? 'ステージ解除' : 'ステージ'}
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
        {error && <div className="modal-error">⚠ {error}</div>}
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
              <span className="changes-section-actions">
                <button
                  className="icon-btn"
                  disabled={busy}
                  title="すべて破棄"
                  onClick={() => void discardAllChanges()}
                >
                  <span className="codicon codicon-trash" />
                </button>
                <button
                  className="icon-btn"
                  disabled={busy}
                  title="すべてステージ"
                  onClick={() => void act(() => api.stageAll(dir))}
                >
                  <span className="codicon codicon-add" />
                </button>
              </span>
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
          <button disabled={busy} onClick={() => void undoLastCommit()}>
            直前のコミットを取り消す
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
            {amend ? 'コミットを修正' : `コミット (${stagedFiles.length} ファイル)`}
          </button>
        </div>
      </div>
      {dialog}
    </div>
  );
}
