import { useEffect, useState } from 'react';
import { api } from '../api';
import type { CommitFile, LogEntry } from '../types';
import DiffPane from './DiffPane';

const STATUS_LABEL: Record<string, string> = {
  A: '追加',
  M: '変更',
  D: '削除',
  R: '名前変更',
  C: 'コピー',
  T: '種別変更',
};

export default function HistoryTab({ dir }: { dir: string }) {
  const [log, setLog] = useState<LogEntry[] | null>(null);
  const [selected, setSelected] = useState<LogEntry | null>(null);
  const [commitFiles, setCommitFiles] = useState<CommitFile[] | null>(null);
  const [selectedFile, setSelectedFile] = useState<CommitFile | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .log(dir, 200)
      .then(setLog)
      .catch((e: Error) => setError(e.message));
  }, [dir]);

  useEffect(() => {
    if (!selected) return;
    setCommitFiles(null);
    setSelectedFile(null);
    api
      .commitFiles(dir, selected.hash)
      .then((files) => {
        setCommitFiles(files);
        if (files.length > 0) setSelectedFile(files[0]);
      })
      .catch((e: Error) => setError(e.message));
  }, [dir, selected]);

  if (error) return <div className="placeholder">⚠ {error}</div>;
  if (log === null) return <div className="placeholder">読み込み中...</div>;
  if (log.length === 0) return <div className="placeholder">コミットがありません</div>;

  return (
    <div className="history-tab">
      <div className="history-list">
        {log.map((entry) => (
          <div
            key={entry.hash}
            className={`log-row ${selected?.hash === entry.hash ? 'selected' : ''}`}
            onClick={() => setSelected(entry)}
          >
            <div className="log-subject">
              {entry.refs && <span className="log-refs">{entry.refs}</span>}
              {entry.subject}
            </div>
            <div className="log-meta">
              <span className="log-hash">{entry.shortHash}</span>
              <span>{entry.author}</span>
              <span>{new Date(entry.date).toLocaleString('ja-JP')}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="history-detail">
        {!selected ? (
          <div className="placeholder">コミットを選択すると詳細を表示します</div>
        ) : (
          <>
            <div className="commit-head">
              <div className="commit-subject">{selected.subject}</div>
              <div className="commit-meta">
                <span className="log-hash">{selected.shortHash}</span>
                <span>{selected.author}</span>
                <span>{new Date(selected.date).toLocaleString('ja-JP')}</span>
              </div>
              <div className="commit-files">
                {commitFiles === null ? (
                  <span className="commit-files-loading">ファイル一覧を読み込み中...</span>
                ) : (
                  commitFiles.map((file) => (
                    <div
                      key={file.path}
                      className={`change-row ${selectedFile?.path === file.path ? 'selected' : ''}`}
                      onClick={() => setSelectedFile(file)}
                      title={`${STATUS_LABEL[file.status] ?? file.status}: ${file.path}`}
                    >
                      <span className={`change-mark mark-${file.status}`}>{file.status}</span>
                      <span className="change-path">
                        {file.origPath ? `${file.origPath} → ${file.path}` : file.path}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className="commit-diff">
              {selectedFile ? (
                <DiffPane
                  dir={dir}
                  path={selectedFile.path}
                  scope="commit"
                  hash={selected.hash}
                  origPath={selectedFile.origPath}
                />
              ) : (
                <div className="placeholder">ファイルを選択すると差分を表示します</div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
