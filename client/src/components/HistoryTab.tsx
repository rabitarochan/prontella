import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { api } from '../api';
import { useConfirm } from './ConfirmDialog';
import ContextMenu, { type ContextMenuItem } from './ContextMenu';
import { layoutGraph, laneColor, type GraphRow } from '../graph';
import type { CommitFile, GitOperation, LogEntry, ResetMode } from '../types';
import DiffPane from './DiffPane';

const RESET_MODES: readonly ResetMode[] = ['soft', 'mixed', 'hard'];

const ROW_H = 28;
const LANE_W = 14;
const MIN_COL_W = 40;
const COLS_KEY = 'deck3:historyColumns';

type ColKey = 'tree' | 'subject' | 'commit' | 'author' | 'date';
// tree is null while it tracks the computed graph width; a drag pins it to a number.
type ColWidths = { tree: number | null; subject: number; commit: number; author: number; date: number };
const DEFAULT_COLS: ColWidths = { tree: null, subject: 360, commit: 90, author: 110, date: 150 };

const COLUMNS: { key: ColKey; label: string }[] = [
  { key: 'tree', label: 'ツリー' },
  { key: 'subject', label: '説明' },
  { key: 'commit', label: 'コミット' },
  { key: 'author', label: '作者' },
  { key: 'date', label: '日時' },
];

function loadCols(): ColWidths {
  try {
    const raw = localStorage.getItem(COLS_KEY);
    if (raw) return { ...DEFAULT_COLS, ...JSON.parse(raw) };
  } catch {
    // ignore malformed / unavailable storage
  }
  return DEFAULT_COLS;
}

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

/** git log --format=%B の全文(subject + 空行 + body)から、1 行目(subject)を除いた本文だけを取り出す。 */
function bodyFromMessage(message: string): string {
  const idx = message.indexOf('\n');
  if (idx === -1) return '';
  return message.slice(idx + 1).replace(/^\n+/, '').trimEnd();
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

export default function HistoryTab({
  dir,
  operation,
  busy,
  dirty,
  untracked,
  onAct,
}: {
  dir: string;
  /** 進行中の merge/rebase 等。非 null の間は reset メニューを disabled にする(リスク R7)。 */
  operation: GitOperation | null;
  /** GitTab 側の busy(act() 実行中)。operation を作らない reset 実行中などにも commitMenuItems
   * を disabled にするため必要 — operation だけを見ていると、その窓で別コミットへの操作が
   * 並走して git の index.lock 起因のエラーになり得る(Phase 5 ゲート 5.R 指摘)。 */
  busy: boolean;
  /** worktree.status 由来の未コミット変更件数(staged+unstaged のみ、tracked)。hard reset の
   * 確認文言用 — `git reset --hard` は untracked ファイルを削除しないため untracked は含めない
   * (Phase 5 ゲート 5.V 指摘: 含めると実際に失われる件数より過大表示になる)。 */
  dirty: number;
  /** worktree.status 由来の未追跡ファイル件数。hard reset でも保持される旨の案内文言用。 */
  untracked: number;
  /** GitTab.act() をそのまま受け取る — busy/message 表示と reset 後の 3 点セット
   * (load + refreshDeck + reloadKey++、成功/失敗いずれも)を GitTab 側に一本化するため。 */
  onAct: (fn: () => Promise<unknown>, successMsg?: string) => void;
}) {
  const [log, setLog] = useState<LogEntry[] | null>(null);
  const [showAll, setShowAll] = useState(true);
  const [selected, setSelected] = useState<LogEntry | null>(null);
  const [commitFiles, setCommitFiles] = useState<CommitFile[] | null>(null);
  const [selectedFile, setSelectedFile] = useState<CommitFile | null>(null);
  const [commitBody, setCommitBody] = useState('');
  const [error, setError] = useState('');
  const [cols, setCols] = useState<ColWidths>(loadCols);
  const [commitMenu, setCommitMenu] = useState<{ x: number; y: number; entry: LogEntry } | null>(null);
  const { confirm: confirmDialog, dialog } = useConfirm();

  useEffect(() => {
    try {
      localStorage.setItem(COLS_KEY, JSON.stringify(cols));
    } catch {
      // ignore quota / unavailable storage
    }
  }, [cols]);

  useEffect(() => {
    setLog(null);
    api
      .log(dir, 300, showAll)
      .then(setLog)
      .catch((e: Error) => setError(e.message));
  }, [dir, showAll]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setCommitFiles(null);
    setSelectedFile(null);
    setCommitBody('');
    api
      .commitFiles(dir, selected.hash)
      .then((files) => {
        if (cancelled) return;
        setCommitFiles(files);
        if (files.length > 0) setSelectedFile(files[0]);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    api
      .commitMessage(dir, selected.hash)
      .then(({ message }) => !cancelled && setCommitBody(bodyFromMessage(message)))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [dir, selected]);

  const graph = useMemo(() => (log ? layoutGraph(log) : []), [log]);
  const graphWidth = useMemo(
    () => Math.max(2, ...graph.map((r) => r.laneCount)) * LANE_W + LANE_W / 2,
    [graph],
  );

  const treeW = cols.tree ?? graphWidth;
  const totalW = treeW + cols.subject + cols.commit + cols.author + cols.date;

  const colStyle = (key: ColKey): CSSProperties => {
    if (key === 'subject') return { flex: `1 0 ${cols.subject}px`, minWidth: 0 };
    const w = key === 'tree' ? treeW : cols[key];
    return { flex: `0 0 ${w}px`, width: w };
  };

  const startResize = (key: ColKey) => (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = key === 'tree' ? treeW : cols[key];
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(MIN_COL_W, startW + (ev.clientX - startX));
      setCols((c) => ({ ...c, [key]: next }));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // reset は非破壊 (soft/mixed) でも history の見た目が変わる操作のため、3 モードとも
  // ConfirmDialog を経由する (soft/mixed は severity: 'normal'、hard のみ 'danger')。
  const doReset = async (entry: LogEntry, mode: ResetMode) => {
    const ok = await confirmDialog({
      title: `Reset (${mode})`,
      message: (
        <>
          <div>
            HEAD を {entry.shortHash} ({entry.subject}) まで戻します ({mode})。
          </div>
          {mode === 'hard' && dirty > 0 && <div>※ 未コミットの変更 {dirty} 件が失われます。</div>}
          {mode === 'hard' && untracked > 0 && (
            <div>※ 未追跡ファイル {untracked} 件は保持されます。</div>
          )}
          {mode === 'hard' && <div>※ 元に戻せません</div>}
        </>
      ),
      confirmLabel: 'Reset',
      severity: mode === 'hard' ? 'danger' : 'normal',
    });
    if (!ok) return;
    onAct(() => api.reset(dir, entry.hash, mode), `${entry.shortHash} まで reset しました (${mode})`);
  };

  // cherry-pick は競合し得るが git 自身が非破壊的に扱う (作業ツリーが cherry-pick 進行中の
  // 状態に入るだけで、続行/中止は GitTab の operation バナー (Phase 3) が受け止める) ため
  // severity は 'normal'。
  const doCherryPick = async (entry: LogEntry) => {
    const ok = await confirmDialog({
      title: 'チェリーピック',
      message: `'${entry.shortHash}' (${entry.subject}) を現在のブランチに適用しますか?`,
      confirmLabel: 'チェリーピック',
      severity: 'normal',
    });
    if (!ok) return;
    onAct(() => api.cherryPick(dir, entry.hash), `${entry.shortHash} をチェリーピックしました`);
  };

  // revert も cherry-pick と同様、競合しても git 自身が進行中状態 (REVERT_HEAD) に留め置く
  // だけの非破壊操作なので severity は 'normal'。マージコミットは -m 未対応のため git 自身の
  // エラーがそのまま表示される (スコープ外、ブリーフ参照)。
  const doRevert = async (entry: LogEntry) => {
    const ok = await confirmDialog({
      title: 'リバート',
      message: `'${entry.shortHash}' (${entry.subject}) を打ち消すコミットを作成しますか?`,
      confirmLabel: 'リバート',
      severity: 'normal',
    });
    if (!ok) return;
    onAct(() => api.revert(dir, entry.hash), `${entry.shortHash} をリバートしました`);
  };

  const commitMenuItems = (entry: LogEntry): ContextMenuItem[] => [
    ...RESET_MODES.map((mode) => ({
      label: `ここまで reset (${mode})…`,
      icon: 'discard',
      disabled: busy || !!operation,
      danger: mode === 'hard',
      onClick: () => void doReset(entry, mode),
    })),
    {
      label: 'このコミットをチェリーピック…',
      icon: 'git-commit',
      disabled: busy || !!operation,
      onClick: () => void doCherryPick(entry),
    },
    {
      label: 'このコミットをリバート…',
      icon: 'reply',
      disabled: busy || !!operation,
      onClick: () => void doRevert(entry),
    },
  ];

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
          <div className="graph-header" style={{ minWidth: totalW }}>
            {COLUMNS.map((col) => (
              <div key={col.key} className="graph-hcell" style={colStyle(col.key)}>
                <span className="graph-hlabel">{col.label}</span>
                <span className="col-resize-handle" onMouseDown={startResize(col.key)} />
              </div>
            ))}
          </div>
          {log === null ? (
            <div className="placeholder">読み込み中...</div>
          ) : log.length === 0 ? (
            <div className="placeholder">コミットがありません</div>
          ) : (
            log.map((entry, i) => (
              <div
                key={entry.hash}
                className={`graph-row ${selected?.hash === entry.hash ? 'selected' : ''}`}
                style={{ height: ROW_H, minWidth: totalW }}
                onClick={() => setSelected(entry)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCommitMenu({ x: e.clientX, y: e.clientY, entry });
                }}
              >
                <div className="graph-cell" style={colStyle('tree')}>
                  <GraphCell row={graph[i]} />
                </div>
                <div className="graph-subject" style={colStyle('subject')}>
                  <RefChips refs={entry.refs} />
                  <span className="graph-subject-text" title={entry.subject}>
                    {entry.subject}
                  </span>
                </div>
                <span className="graph-hash" style={colStyle('commit')}>
                  {entry.shortHash}
                </span>
                <span className="graph-author" style={colStyle('author')} title={entry.author}>
                  {entry.author}
                </span>
                <span className="graph-date" style={colStyle('date')}>
                  {new Date(entry.date).toLocaleString('ja-JP')}
                </span>
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
                {commitBody && <div className="commit-body">{commitBody}</div>}
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
      {commitMenu && (
        <ContextMenu
          x={commitMenu.x}
          y={commitMenu.y}
          items={commitMenuItems(commitMenu.entry)}
          onClose={() => setCommitMenu(null)}
        />
      )}
      {dialog}
    </div>
  );
}
