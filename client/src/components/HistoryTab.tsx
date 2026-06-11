import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { layoutGraph, laneColor, type GraphRow } from '../graph';
import type { CommitFile, LogEntry } from '../types';
import DiffPane from './DiffPane';

const ROW_H = 28;
const LANE_W = 14;

function GraphCell({ row }: { row: GraphRow }) {
  const width = row.laneCount * LANE_W + LANE_W / 2;
  const x = (lane: number) => lane * LANE_W + LANE_W / 2;
  const mid = ROW_H / 2;
  const dotX = x(row.dot);
  return (
    <svg width={width} height={ROW_H} className="graph-svg">
      {row.passing.map((lane) => (
        <line key={`p${lane}`} x1={x(lane)} y1={0} x2={x(lane)} y2={ROW_H} stroke={laneColor(lane)} strokeWidth={2} />
      ))}
      {row.topToDot.map((lane) => (
        <path
          key={`t${lane}`}
          d={`M ${x(lane)} 0 C ${x(lane)} ${mid * 0.8}, ${dotX} ${mid * 0.4}, ${dotX} ${mid}`}
          stroke={laneColor(lane)}
          strokeWidth={2}
          fill="none"
        />
      ))}
      {row.dotToBottom.map((lane) => (
        <path
          key={`b${lane}`}
          d={`M ${dotX} ${mid} C ${dotX} ${mid + mid * 0.6}, ${x(lane)} ${mid + mid * 0.2}, ${x(lane)} ${ROW_H}`}
          stroke={laneColor(lane)}
          strokeWidth={2}
          fill="none"
        />
      ))}
      <circle cx={dotX} cy={mid} r={4} fill={laneColor(row.dot)} stroke="#1e1e23" strokeWidth={1.5} />
    </svg>
  );
}

function RefChips({ refs }: { refs: string }) {
  if (!refs) return null;
  return (
    <>
      {refs.split(', ').map((ref) => {
        let label = ref;
        let cls = 'ref-local';
        if (ref.startsWith('HEAD -> ')) {
          label = ref.slice('HEAD -> '.length);
          cls = 'ref-head';
        } else if (ref === 'HEAD') {
          cls = 'ref-head';
        } else if (ref.startsWith('tag: ')) {
          label = ref.slice(5);
          cls = 'ref-tag';
        } else if (/^(origin|upstream)\//.test(ref)) {
          cls = 'ref-remote';
        }
        return (
          <span key={ref} className={`ref-chip ${cls}`} title={ref}>
            {label}
          </span>
        );
      })}
    </>
  );
}

export default function HistoryTab({ dir }: { dir: string }) {
  const [log, setLog] = useState<LogEntry[] | null>(null);
  const [showAll, setShowAll] = useState(true);
  const [selected, setSelected] = useState<LogEntry | null>(null);
  const [commitFiles, setCommitFiles] = useState<CommitFile[] | null>(null);
  const [selectedFile, setSelectedFile] = useState<CommitFile | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setLog(null);
    api
      .log(dir, 300, showAll)
      .then(setLog)
      .catch((e: Error) => setError(e.message));
  }, [dir, showAll]);

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

  const graph = useMemo(() => (log ? layoutGraph(log) : []), [log]);
  const graphWidth = useMemo(
    () => Math.max(2, ...graph.map((r) => r.laneCount)) * LANE_W + LANE_W / 2,
    [graph],
  );

  if (error) return <div className="placeholder">⚠ {error}</div>;

  return (
    <div className="history-v">
      <div className="graph-pane">
        <div className="graph-toolbar">
          <label className="branches-remote-toggle">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
            全ブランチを表示 (--all)
          </label>
          {log && <span className="graph-count">{log.length} コミット</span>}
        </div>
        <div className="graph-scroll">
          {log === null ? (
            <div className="placeholder">読み込み中...</div>
          ) : log.length === 0 ? (
            <div className="placeholder">コミットがありません</div>
          ) : (
            log.map((entry, i) => (
              <div
                key={entry.hash}
                className={`graph-row ${selected?.hash === entry.hash ? 'selected' : ''}`}
                style={{ height: ROW_H }}
                onClick={() => setSelected(entry)}
              >
                <div className="graph-cell" style={{ width: graphWidth }}>
                  <GraphCell row={graph[i]} />
                </div>
                <div className="graph-subject">
                  <RefChips refs={entry.refs} />
                  <span className="graph-subject-text" title={entry.subject}>
                    {entry.subject}
                  </span>
                </div>
                <span className="graph-hash">{entry.shortHash}</span>
                <span className="graph-author" title={entry.author}>
                  {entry.author}
                </span>
                <span className="graph-date">{new Date(entry.date).toLocaleString('ja-JP')}</span>
              </div>
            ))
          )}
        </div>
      </div>
      <div className="commit-pane">
        {!selected ? (
          <div className="placeholder">コミットを選択すると詳細を表示します</div>
        ) : (
          <>
            <div className="commit-side">
              <div className="commit-head">
                <div className="commit-subject">{selected.subject}</div>
                <div className="commit-meta">
                  <span className="log-hash">{selected.shortHash}</span>
                  <span>{selected.author}</span>
                </div>
                <div className="commit-meta">{new Date(selected.date).toLocaleString('ja-JP')}</div>
              </div>
              <div className="commit-files">
                {commitFiles === null ? (
                  <span className="commit-files-loading">読み込み中...</span>
                ) : (
                  commitFiles.map((file) => (
                    <div
                      key={file.path}
                      className={`change-row ${selectedFile?.path === file.path ? 'selected' : ''}`}
                      onClick={() => setSelectedFile(file)}
                      title={file.path}
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
