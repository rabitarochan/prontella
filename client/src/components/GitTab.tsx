import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useDeck } from '../store';
import type {
  BranchInfo,
  GitOperation,
  GitOperationAction,
  Repo,
  StashEntry,
  StatusFile,
  Worktree,
} from '../types';
import BranchTree from './BranchTree';
import ChangesTab from './ChangesTab';
import { useConfirm } from './ConfirmDialog';
import ContextMenu, { type ContextMenuItem } from './ContextMenu';
import DiffTabsPane, { conflictTabKey, diffTabKey, type WorkTab } from './DiffTabsPane';
import HistoryTab from './HistoryTab';

type GitView = 'status' | 'history';

const POLL_MS = 10_000;

const OPERATION_LABELS: Record<GitOperation, string> = {
  merge: 'マージ',
  rebase: 'リベース',
  'cherry-pick': 'チェリーピック',
  revert: 'リバート',
};

// git merge に --skip は存在しない (server/git.ts の OPERATION_SKIP_UNSUPPORTED と手動同期)。
const OPERATION_SKIP_UNSUPPORTED: readonly GitOperation[] = ['merge'];

export default function GitTab({ repo, worktree }: { repo: Repo; worktree: Worktree }) {
  const refreshDeck = useDeck((s) => s.refresh);
  const { confirm: confirmDialog, dialog } = useConfirm();
  const [view, setView] = useState<GitView>('status');
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [stashes, setStashes] = useState<StashEntry[]>([]);
  const [openLocal, setOpenLocal] = useState(true);
  const [openRemote, setOpenRemote] = useState(false);
  const [openStash, setOpenStash] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [operation, setOperation] = useState<GitOperation | null>(null);
  const [branchMenu, setBranchMenu] = useState<{ x: number; y: number; branch: BranchInfo } | null>(
    null,
  );
  // 変更リストで選択したファイルの diff/競合解決タブ。ChangesTab は reloadKey で
  // 再マウントされるので、タブはここ (GitTab) が持って生き残らせる。
  const [diffTabs, setDiffTabs] = useState<WorkTab[]>([]);
  const [activeDiff, setActiveDiff] = useState<string | null>(null);

  const openDiff = useCallback((file: StatusFile, staged: boolean) => {
    const key = diffTabKey(file, staged);
    setDiffTabs((prev) => {
      const hit = prev.find((t) => t.key === key);
      // 既存タブの再クリックは最新の差分を取り直す
      if (hit) return prev.map((t) => (t.key === key && t.kind === 'diff' ? { ...t, gen: t.gen + 1 } : t));
      return [
        ...prev,
        {
          kind: 'diff',
          key,
          path: file.path,
          origPath: file.origPath,
          staged,
          untracked: file.untracked,
          gen: 0,
        },
      ];
    });
    setActiveDiff(key);
  }, []);

  // 競合ファイルは解決ペイン (ConflictResolvePane) をタブで開く。diff タブと違い
  // 編集状態を持つステートフルなタブなので、既存タブがあれば内容を保ったまま
  // アクティブ化するだけ (再クリックで gen を増やして作り直す、はしない)。
  const openConflict = useCallback((file: StatusFile) => {
    const key = conflictTabKey(file.path);
    setDiffTabs((prev) => (prev.some((t) => t.key === key) ? prev : [...prev, { kind: 'conflict', key, path: file.path }]));
    setActiveDiff(key);
  }, []);

  const closeDiff = useCallback(
    (key: string) => {
      setDiffTabs((prev) => prev.filter((t) => t.key !== key));
      setActiveDiff((current) => {
        if (current !== key) return current;
        const idx = diffTabs.findIndex((t) => t.key === key);
        const next = diffTabs.filter((t) => t.key !== key);
        return next[idx]?.key ?? next[idx - 1]?.key ?? null;
      });
    },
    [diffTabs],
  );

  const reloadDiff = useCallback((key: string) => {
    setDiffTabs((prev) =>
      prev.map((t) => (t.key === key && t.kind === 'diff' ? { ...t, gen: t.gen + 1 } : t)),
    );
  }, []);

  const dir = worktree.path;
  const currentBranch = worktree.branch;

  const load = useCallback(() => {
    api.branches(repo.id).then(setBranches).catch(() => {});
    api.stashList(dir).then(setStashes).catch(() => {});
    api
      .gitStatus(dir)
      .then((s) => setOperation(s.operation))
      .catch(() => {});
  }, [repo.id, dir]);

  useEffect(() => {
    if (repo.gitMode === 'none') return;
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load, repo.gitMode]);

  // 競合解決 (ConflictResolvePane の全体採用/解決済み) が成功した後の「status 更新」。
  // GitTab 自身の act() と同じ 3 点セット (branches/stashes/operation の再取得・
  // worktree.status の更新・ChangesTab/HistoryTab の強制再フェッチ) だが、これは
  // DiffTabsPane 配下からの通知なので busy/message は動かさない (競合解決側が自前で持つ)。
  const onConflictResolved = useCallback(() => {
    load();
    void refreshDeck();
    setReloadKey((k) => k + 1);
  }, [load, refreshDeck]);

  const act = async (fn: () => Promise<unknown>, successMsg?: string) => {
    setBusy(true);
    setMessage('');
    try {
      await fn();
      load();
      await refreshDeck();
      setReloadKey((k) => k + 1); // force changes/history views to refetch
      if (successMsg) setMessage(`✓ ${successMsg}`);
    } catch (e) {
      setMessage(`⚠ ${e instanceof Error ? e.message : String(e)}`);
      // git コマンドがエラーで終わっても (例: merge が競合で非ゼロ終了)、その時点で
      // 作業ツリー/インデックスは実際に変化していることが多い (マージ進行中バナー・
      // 競合ファイル一覧など)。次回ポーリング (POLL_MS) 任せにせず、成功パスと同じ
      // 3 点セットで即時反映する。reloadKey は diff タブ (読み取り専用の DiffPane。
      // key に reloadKey を含むので再フェッチされるだけ) には安全に効くが、競合解決
      // タブ (ConflictResolvePane) は reloadKey/gen を key に使わない設計
      // (DiffTabsPane 参照) なので、未保存の解決作業がこれで失われることはない。
      load();
      await refreshDeck();
      setReloadKey((k) => k + 1);
    } finally {
      setBusy(false);
    }
  };

  const createBranch = () => {
    const name = prompt('新しいブランチ名 (現在の HEAD から作成して切り替え):');
    if (!name?.trim()) return;
    void act(() => api.switchBranch(dir, name.trim(), true), `${name.trim()} を作成しました`);
  };

  const stashCurrent = () => {
    const msg = prompt('スタッシュのメッセージ (省略可):');
    if (msg === null) return;
    void act(() => api.stashPush(dir, msg || undefined), 'スタッシュしました');
  };

  const deleteBranch = (branch: string) => {
    if (!confirm(`ブランチ ${branch} を削除しますか?`)) return;
    void act(async () => {
      try {
        await api.deleteBranch(dir, branch);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (confirm(`削除に失敗しました:\n${msg}\n\nマージされていないコミットごと強制削除しますか?`)) {
          await api.deleteBranch(dir, branch, true);
        } else {
          throw e;
        }
      }
    }, 'ブランチを削除しました');
  };

  const openBranchMenu = useCallback((e: React.MouseEvent, branch: BranchInfo) => {
    setBranchMenu({ x: e.clientX, y: e.clientY, branch });
  }, []);

  const mergeBranch = async (b: BranchInfo, ffOnly: boolean) => {
    const target = currentBranch ?? '現在のブランチ';
    const ok = await confirmDialog({
      title: 'マージ',
      message: ffOnly
        ? `'${b.name}' を ${target} に fast-forward のみでマージしますか?`
        : `'${b.name}' を ${target} にマージしますか? (--no-ff)`,
      confirmLabel: 'マージ',
      severity: 'normal',
    });
    if (!ok) return;
    void act(
      () => api.merge(dir, b.name, ffOnly ? { ffOnly: true } : { noFf: true }),
      'マージしました',
    );
  };

  // 進行中操作 (merge/rebase/cherry-pick/revert) の続行/中止/スキップ。abort は破壊的操作
  // (作業ツリーを操作開始前の状態に戻す) のため ConfirmDialog(danger) を経由し、
  // continue/skip は git 自身が競合未解決なら拒否するフェイルセーフのため確認なしで実行する。
  const runOperation = async (action: GitOperationAction) => {
    if (!operation) return;
    const label = OPERATION_LABELS[operation];
    if (action === 'abort') {
      const ok = await confirmDialog({
        title: `${label}を中止`,
        message: `進行中の${label}を中止して元の状態に戻します。よろしいですか?`,
        confirmLabel: '中止',
        severity: 'danger',
      });
      if (!ok) return;
    }
    const successMsg =
      action === 'abort'
        ? `${label}を中止しました`
        : action === 'skip'
          ? `${label}を 1 件スキップしました`
          : `${label}を続行しました`;
    void act(() => api.operationAction(dir, operation, action), successMsg);
  };

  const branchMenuItems = (b: BranchInfo): ContextMenuItem[] => {
    const usedElsewhere = !!b.worktreePath && b.worktreePath !== worktree.path.replace(/\\/g, '/');
    return [
      {
        label: '切り替え',
        icon: 'arrow-swap',
        disabled: busy || usedElsewhere,
        onClick: () => void act(() => api.switchBranch(dir, b.name), `${b.name} に切り替えました`),
      },
      {
        label: `'${b.name}' を現在のブランチにマージ (--no-ff)`,
        icon: 'git-merge',
        disabled: busy,
        onClick: () => void mergeBranch(b, false),
      },
      {
        label: 'fast-forward のみでマージ',
        icon: 'git-merge',
        disabled: busy,
        onClick: () => void mergeBranch(b, true),
      },
      {
        label: '削除',
        icon: 'trash',
        disabled: busy || usedElsewhere,
        danger: true,
        onClick: () => deleteBranch(b.name),
      },
    ];
  };

  const locals = branches.filter((b) => !b.remote);
  const remotes = branches.filter((b) => b.remote);
  const dirty =
    (worktree.status?.staged ?? 0) +
    (worktree.status?.unstaged ?? 0) +
    (worktree.status?.untracked ?? 0);

  const sectionHead = (
    title: string,
    open: boolean,
    toggle: () => void,
    action?: { icon: string; title: string; onClick: () => void },
  ) => (
    <div className="git-section-head" onClick={toggle}>
      <span>
        <span className={`codicon codicon-chevron-${open ? 'down' : 'right'}`} /> {title}
      </span>
      {action && (
        <button
          className="icon-btn"
          title={action.title}
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            action.onClick();
          }}
        >
          <span className={`codicon codicon-${action.icon}`} />
        </button>
      )}
    </div>
  );

  if (repo.gitMode === 'none') {
    return (
      <div className="placeholder">
        <p>Git リポジトリーではありません</p>
        <button
          className="primary"
          disabled={busy}
          onClick={() => void act(() => api.gitInit(dir), 'git init を実行しました')}
        >
          git init を実行
        </button>
        {message && <div className="git-side-msg">{message}</div>}
      </div>
    );
  }

  return (
    <div className="git-tab">
      <div className="git-side">
        <div className="git-section-head git-section-title">ワークスペース</div>
        <div
          className={`git-nav-row ${view === 'status' ? 'active' : ''}`}
          onClick={() => setView('status')}
        >
          <span className="codicon codicon-diff-multiple" /> ファイルステータス
          {dirty > 0 && <span className="wt-dirty">{dirty}</span>}
        </div>
        <div
          className={`git-nav-row ${view === 'history' ? 'active' : ''}`}
          onClick={() => setView('history')}
        >
          <span className="codicon codicon-history" /> 履歴
        </div>

        {sectionHead('ブランチ', openLocal, () => setOpenLocal((v) => !v), {
          icon: 'add',
          title: '新しいブランチを作成',
          onClick: createBranch,
        })}
        {openLocal && (
          <BranchTree
            branches={locals}
            currentBranch={currentBranch}
            worktreePath={worktree.path}
            onContextMenu={openBranchMenu}
          />
        )}

        {sectionHead('リモート', openRemote, () => setOpenRemote((v) => !v))}
        {openRemote &&
          (remotes.length === 0 ? (
            <div className="git-side-empty">リモートブランチはありません</div>
          ) : (
            <BranchTree branches={remotes} />
          ))}

        {sectionHead('スタッシュ', openStash, () => setOpenStash((v) => !v), {
          icon: 'archive',
          title: '現在の変更をスタッシュ (未追跡ファイル含む)',
          onClick: stashCurrent,
        })}
        {openStash &&
          (stashes.length === 0 ? (
            <div className="git-side-empty">スタッシュはありません</div>
          ) : (
            stashes.map((s) => (
              <div key={s.ref} className="git-branch-row" title={`${s.ref}: ${s.message}`}>
                <span className="codicon codicon-archive branch-icon" />
                <span className="branch-name">{s.message}</span>
                <span className="branch-actions">
                  <button
                    className="icon-btn"
                    title="適用して削除 (pop)"
                    disabled={busy}
                    onClick={() => void act(() => api.stashApply(dir, s.ref, true), '適用しました')}
                  >
                    <span className="codicon codicon-debug-step-out" />
                  </button>
                  <button
                    className="icon-btn"
                    title="適用 (スタッシュは残す)"
                    disabled={busy}
                    onClick={() => void act(() => api.stashApply(dir, s.ref, false), '適用しました')}
                  >
                    <span className="codicon codicon-desktop-download" />
                  </button>
                  <button
                    className="icon-btn"
                    title="削除"
                    disabled={busy}
                    onClick={() => {
                      if (confirm(`${s.ref} を削除しますか?\n${s.message}`)) {
                        void act(() => api.stashDrop(dir, s.ref), '削除しました');
                      }
                    }}
                  >
                    <span className="codicon codicon-trash" />
                  </button>
                </span>
              </div>
            ))
          ))}

        {message && <div className="git-side-msg">{message}</div>}
      </div>
      <div className="git-main">
        {operation && (
          <div className="operation-banner">
            <span>⚠ {OPERATION_LABELS[operation]}進行中 — コンフリクトを解決してから続行してください</span>
            <span className="operation-actions">
              <button className="primary" disabled={busy} onClick={() => void runOperation('continue')}>
                続行
              </button>
              {!OPERATION_SKIP_UNSUPPORTED.includes(operation) && (
                <button disabled={busy} onClick={() => void runOperation('skip')}>
                  スキップ
                </button>
              )}
              <button className="danger" disabled={busy} onClick={() => void runOperation('abort')}>
                中止
              </button>
            </span>
          </div>
        )}
        <div className="git-main-content">
          {view === 'status' ? (
            <div className="changes-wrap">
              <ChangesTab
                key={`s${reloadKey}`}
                dir={dir}
                onOpenDiff={openDiff}
                onOpenConflict={openConflict}
                selectedKey={activeDiff}
              />
              <DiffTabsPane
                dir={dir}
                tabs={diffTabs}
                activeKey={activeDiff}
                reloadKey={reloadKey}
                onActivate={setActiveDiff}
                onClose={closeDiff}
                onReload={reloadDiff}
                onStatusChanged={onConflictResolved}
              />
            </div>
          ) : (
            <HistoryTab key={`h${reloadKey}`} dir={dir} />
          )}
        </div>
      </div>
      {branchMenu && (
        <ContextMenu
          x={branchMenu.x}
          y={branchMenu.y}
          items={branchMenuItems(branchMenu.branch)}
          onClose={() => setBranchMenu(null)}
        />
      )}
      {dialog}
    </div>
  );
}
