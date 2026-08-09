import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { useT, type StringKey } from '../i18n';
import { useTileBarSlots } from '../layout/tileBarSlots';
import { useDeck } from '../store';
import type {
  ActiveRepo,
  BranchInfo,
  GitOperation,
  GitOperationAction,
  RemoteInfo,
  StashEntry,
  StatusFile,
  TagInfo,
  Worktree,
} from '../types';
import BranchTree from './BranchTree';
import ChangesTab from './ChangesTab';
import { useConfirm } from './ConfirmDialog';
import ContextMenu, { type ContextMenuItem } from './ContextMenu';
import DiffTabsPane, { conflictTabKey, diffTabKey, stashTabKey, type WorkTab } from './DiffTabsPane';
import HistoryTab from './HistoryTab';
import { usePrompt } from './PromptDialog';

type GitView = 'status' | 'history';

const POLL_MS = 10_000;

const OPERATION_LABEL_KEYS: Record<GitOperation, StringKey> = {
  merge: 'git.merge',
  rebase: 'git.rebase',
  'cherry-pick': 'git.cherryPick',
  revert: 'git.revert',
};

// git merge に --skip は存在しない (server/git.ts の OPERATION_SKIP_UNSUPPORTED と手動同期)。
const OPERATION_SKIP_UNSUPPORTED: readonly GitOperation[] = ['merge'];

export default function GitTab({
  repo,
  worktree,
  visible,
  leafId,
}: {
  repo: ActiveRepo;
  worktree: Worktree;
  /** このタイルが現在表示中(タイルのタブが 'git')かどうか。非表示中はポーリングを止める。 */
  visible: boolean;
  /** タイルの leaf id (安定・leaf 間で重複しない)。DiffTabsPane → ConflictResolvePane の
   *  Monaco モデル名前空間に使う (FilesTab の modelPath と同じ機構)。 */
  leafId: string;
}) {
  const t = useT();
  const refreshDeck = useDeck((s) => s.refresh);
  const { confirm: confirmDialog, dialog } = useConfirm();
  const { prompt: promptDialog, dialog: promptDlg } = usePrompt();
  const [view, setView] = useState<GitView>('status');
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [gitRemotes, setGitRemotes] = useState<RemoteInfo[]>([]);
  const [stashes, setStashes] = useState<StashEntry[]>([]);
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [openLocal, setOpenLocal] = useState(true);
  const [openRemote, setOpenRemote] = useState(false);
  const [openStash, setOpenStash] = useState(true);
  const [openTags, setOpenTags] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [operation, setOperation] = useState<GitOperation | null>(null);
  const [branchMenu, setBranchMenu] = useState<{ x: number; y: number; branch: BranchInfo } | null>(
    null,
  );
  // リモート同期バー (fetch/pull/push)。P8-2 で WorktreeView ヘッダーから移設。
  // busy は act() が持つので、これはスピナー表示用の「どのボタンか」だけを持つ。
  const [syncing, setSyncing] = useState<'fetch' | 'pull' | 'push' | null>(null);
  const [syncMenu, setSyncMenu] = useState<{ x: number; y: number; kind: 'pull' | 'push' } | null>(
    null,
  );
  // タイルバーのメインゾーンスロット (1 段化)。hook のため gitMode==='none' の
  // 早期 return より前で購読する。表示中 (visible) のビューだけがバーを使う
  const barSlot = useTileBarSlots((s) => s.slots[leafId] ?? null);
  const inBar = visible && barSlot !== null;
  // 変更リストで選択したファイルの diff/競合解決タブ。ChangesTab は reloadKey で
  // 再マウントされるので、タブはここ (GitTab) が持って生き残らせる。
  const [diffTabs, setDiffTabs] = useState<WorkTab[]>([]);
  const [activeDiff, setActiveDiff] = useState<string | null>(null);

  const openDiff = useCallback((file: StatusFile, staged: boolean) => {
    const key = diffTabKey(file, staged);
    setDiffTabs((prev) => {
      const hit = prev.find((tab) => tab.key === key);
      // 既存タブの再クリックは最新の差分を取り直す
      if (hit)
        return prev.map((tab) => (tab.key === key && tab.kind === 'diff' ? { ...tab, gen: tab.gen + 1 } : tab));
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
    setDiffTabs((prev) =>
      prev.some((tab) => tab.key === key) ? prev : [...prev, { kind: 'conflict', key, path: file.path }],
    );
    setActiveDiff(key);
  }, []);

  // スタッシュの中身 (git stash show -p) は読み取り専用のプレーンテキストタブで開く
  // (StashDiffPane 参照)。競合タブと同じく再クリックで作り直しはしない — 内容は
  // stash@{N} という参照が指す時点のスナップショットで、タブを開いている間に変わる想定が薄い。
  const openStashDiff = useCallback((s: StashEntry) => {
    const key = stashTabKey(s.ref);
    setDiffTabs((prev) =>
      prev.some((tab) => tab.key === key)
        ? prev
        : [...prev, { kind: 'stash', key, ref: s.ref, message: s.message }],
    );
    setActiveDiff(key);
  }, []);

  const closeDiff = useCallback(
    async (key: string) => {
      // 競合タブは編集中の解決作業を保持する唯一のステートフルなタブ
      // (DiffTabsPane 冒頭コメント参照)。タブ全体がミドルクリックの標的に
      // なったので、誤爆で解決作業を失わないよう確認を挟む。
      const target = diffTabs.find((tab) => tab.key === key);
      if (target?.kind === 'conflict') {
        const ok = await confirmDialog({
          title: t('git.closeConflictTitle'),
          message: t('git.closeConflictMessage', { path: target.path }),
          confirmLabel: t('git.discardAndCloseLabel'),
          severity: 'danger',
        });
        if (!ok) return;
      }
      setDiffTabs((prev) => prev.filter((tab) => tab.key !== key));
      setActiveDiff((current) => {
        if (current !== key) return current;
        const idx = diffTabs.findIndex((tab) => tab.key === key);
        const next = diffTabs.filter((tab) => tab.key !== key);
        return next[idx]?.key ?? next[idx - 1]?.key ?? null;
      });
    },
    [diffTabs, confirmDialog],
  );

  const reloadDiff = useCallback((key: string) => {
    setDiffTabs((prev) =>
      prev.map((tab) => (tab.key === key && tab.kind === 'diff' ? { ...tab, gen: tab.gen + 1 } : tab)),
    );
  }, []);

  const dir = worktree.path;
  const currentBranch = worktree.branch;

  const load = useCallback(() => {
    api.branches(repo.id).then(setBranches).catch(() => {});
    api.remotes(dir).then(setGitRemotes).catch(() => {});
    api.stashList(dir).then(setStashes).catch(() => {});
    api.tags(dir).then(setTags).catch(() => {});
    api
      .gitStatus(dir)
      .then((s) => setOperation(s.operation))
      .catch(() => {});
  }, [repo.id, dir]);

  useEffect(() => {
    if (repo.gitMode === 'none') return;
    // タイルが非表示の間はポーリングしない (サーバー側の git.exe 起動を抑える)。
    // visible が false→true になった瞬間もこの effect が再実行されるので、
    // 即 load() してから interval を張り直す形に自然になる。
    if (!visible) return;
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load, repo.gitMode, visible]);

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

  const createBranch = async () => {
    const name = await promptDialog({
      title: t('git.createBranchTitle'),
      message: t('git.createBranchPrompt'),
      confirmLabel: t('git.create'),
    });
    if (!name?.trim()) return;
    void act(
      () => api.switchBranch(dir, name.trim(), true),
      t('git.createdSuccess', { name: name.trim() }),
    );
  };

  const stashCurrent = async () => {
    const msg = await promptDialog({
      title: t('git.stash'),
      message: t('git.stashMessagePrompt'),
      confirmLabel: t('git.stash'),
      allowEmpty: true,
    });
    if (msg === null) return;
    void act(() => api.stashPush(dir, msg || undefined), t('git.stashedSuccess'));
  };

  const deleteBranch = async (branch: string) => {
    if (
      !(await confirmDialog({
        title: t('git.deleteBranchTitle'),
        message: t('git.deleteBranchMessage', { name: branch }),
        confirmLabel: t('common.remove'),
        severity: 'danger',
      }))
    )
      return;
    void act(async () => {
      try {
        await api.deleteBranch(dir, branch);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (
          await confirmDialog({
            title: t('git.forceDeleteBranchTitle'),
            message: t('git.forceDeleteBranchMessage', { message: msg }),
            confirmLabel: t('git.forceDelete'),
            severity: 'danger',
          })
        ) {
          await api.deleteBranch(dir, branch, true);
        } else {
          throw e;
        }
      }
    }, t('git.branchDeletedSuccess'));
  };

  const openBranchMenu = useCallback((e: React.MouseEvent, branch: BranchInfo) => {
    setBranchMenu({ x: e.clientX, y: e.clientY, branch });
  }, []);

  // rename は非破壊操作 (git 自身が名前衝突を拒否する) なので ConfirmDialog は挟まず、
  // 新名の入力だけ PromptDialog (native prompt() の代替) を経由する。
  const renameBranch = async (b: BranchInfo) => {
    const name = await promptDialog({
      title: t('git.renameBranchTitle'),
      message: t('git.renameBranchPrompt', { name: b.name }),
      defaultValue: b.name,
      confirmLabel: t('git.change'),
    });
    if (!name || name === b.name) return;
    void act(
      () => api.renameBranch(dir, b.name, name),
      t('git.renameBranchSuccess', { old: b.name, new: name }),
    );
  };

  const mergeBranch = async (b: BranchInfo, ffOnly: boolean) => {
    const target = currentBranch ?? t('git.currentBranchFallback');
    const ok = await confirmDialog({
      title: t('git.merge'),
      message: ffOnly
        ? t('git.mergeFfOnlyMessage', { name: b.name, target })
        : t('git.mergeMessage', { name: b.name, target }),
      confirmLabel: t('git.merge'),
      severity: 'normal',
    });
    if (!ok) return;
    void act(
      () => api.merge(dir, b.name, ffOnly ? { ffOnly: true } : { noFf: true }),
      t('git.mergedSuccess'),
    );
  };

  // rebase は現在のブランチのコミット列を書き換える操作だが、競合しても abort で rebase 前の
  // HEAD に完全復元できる (Phase 3 の operation 検出が担う) ため danger ではなく normal 確認に
  // する (merge と同じ扱い)。進行中 operation があるとブランチメニューからの多重実行を防ぐため
  // disabled にする (branchMenuItems 側)。
  const rebaseOntoBranch = async (b: BranchInfo) => {
    const target = currentBranch ?? t('git.currentBranchFallback');
    const ok = await confirmDialog({
      title: t('git.rebase'),
      message: t('git.rebaseMessage', { target, name: b.name }),
      confirmLabel: t('git.rebase'),
      severity: 'normal',
    });
    if (!ok) return;
    void act(() => api.rebase(dir, b.name), t('git.rebasedSuccess', { name: b.name }));
  };

  // 進行中操作 (merge/rebase/cherry-pick/revert) の続行/中止/スキップ。abort は破壊的操作
  // (作業ツリーを操作開始前の状態に戻す) のため ConfirmDialog(danger) を経由し、
  // continue/skip は git 自身が競合未解決なら拒否するフェイルセーフのため確認なしで実行する。
  const runOperation = async (action: GitOperationAction) => {
    if (!operation) return;
    const label = t(OPERATION_LABEL_KEYS[operation]);
    if (action === 'abort') {
      const ok = await confirmDialog({
        title: t('git.operationAbortTitle', { label }),
        message: t('git.operationAbortMessage', { label }),
        confirmLabel: t('git.abort'),
        severity: 'danger',
      });
      if (!ok) return;
    }
    const successMsg =
      action === 'abort'
        ? t('git.operationAbortSuccess', { label })
        : action === 'skip'
          ? t('git.operationSkipSuccess', { label })
          : t('git.operationContinueSuccess', { label });
    void act(() => api.operationAction(dir, operation, action), successMsg);
  };

  // BranchInfo.upstreamRemoteRef は 'refs/heads/foo' 形式のことも短縮 'foo' のこともある
  // (server 側の for-each-ref フォーマット依存)。server/git.ts に同趣旨のヘルパーがあるが
  // 共有型機構がないためこのファイル内にも小さく複製する。
  const stripHeadsPrefix = (ref: string): string => ref.replace(/^refs\/heads\//, '');

  // 別名プッシュ (-u 相当) はリモート側ブランチ名をユーザーに指定させる。デフォルト値は
  // ローカル名そのまま (自動推測はしない)。既に upstream が設定されている場合のみ、
  // この操作が upstream を書き換えることを実行前に確認する (merge/rebase と同じ severity: 'normal')。
  const pushBranchAs = async (b: BranchInfo) => {
    const name = await promptDialog({
      title: t('git.pushAsTitle'),
      message: t('git.pushAsPromptMessage', { name: b.name }),
      defaultValue: b.name,
      confirmLabel: t('git.push'),
    });
    if (!name) return;
    if (b.upstream) {
      const remote = b.upstreamRemote ?? 'origin';
      const ok = await confirmDialog({
        title: t('git.pushAsTitle'),
        message: t('git.pushAsConfirmMessage', {
          name: b.name,
          ref: `${remote}/${name}`,
          upstream: b.upstream,
        }),
        confirmLabel: t('git.push'),
        severity: 'normal',
      });
      if (!ok) return;
    }
    void act(() => api.branchPush(dir, b.name, name), t('git.pushAsSuccess', { name: b.name, as: name }));
  };

  // ---- リモート同期 (fetch/pull/push)。act() 経由なので成功/失敗とも
  // branches/stashes/operation・deck の worktree.status・変更/履歴ビューが即時更新される。
  const sync = async (
    kind: 'fetch' | 'pull' | 'push',
    opts?: { rebase?: boolean; forceWithLease?: boolean },
  ) => {
    setSyncing(kind);
    try {
      if (kind === 'fetch') await act(() => api.fetch(dir), t('git.fetchedSuccess'));
      else if (kind === 'pull')
        await act(() => api.pull(dir, { rebase: opts?.rebase }), t('git.pulledSuccess'));
      else await act(() => api.push(dir, { forceWithLease: opts?.forceWithLease }), t('git.pushedGenericSuccess'));
    } finally {
      setSyncing(null);
    }
  };

  // force-with-lease は履歴を書き換える破壊的操作なので ConfirmDialog(danger) 必須。
  // rebase でのプルは非破壊 (競合すれば operation バナーが拾う) のため確認なしで即実行する。
  const forcePush = async () => {
    const ok = await confirmDialog({
      title: t('git.forcePushLabel'),
      message: t('git.forcePushMessage'),
      confirmLabel: t('git.push'),
      severity: 'danger',
    });
    if (!ok) return;
    void sync('push', { forceWithLease: true });
  };

  // カレントブランチの「別名でプッシュ…」。ブランチメニューの pushBranchAs と対称だが、
  // upstream 情報は worktree.status (deck ポーリング由来) を使う (pj-git-route §3)。
  const pushCurrentAs = async () => {
    if (!currentBranch) return;
    const name = await promptDialog({
      title: t('git.pushAsTitle'),
      message: t('git.pushAsPromptMessage', { name: currentBranch }),
      defaultValue: currentBranch,
      confirmLabel: t('git.push'),
    });
    if (!name) return;
    const currentUpstream = worktree.status?.upstream;
    if (currentUpstream) {
      const ok = await confirmDialog({
        title: t('git.pushAsTitle'),
        message: t('git.pushCurrentAsConfirmMessage', {
          name: currentBranch,
          as: name,
          upstream: currentUpstream,
        }),
        confirmLabel: t('git.push'),
        severity: 'normal',
      });
      if (!ok) return;
    }
    void act(
      () => api.branchPush(dir, currentBranch, name),
      t('git.pushAsSuccess', { name: currentBranch, as: name }),
    );
  };

  const syncMenuItems: ContextMenuItem[] =
    syncMenu?.kind === 'pull'
      ? [
          {
            label: t('git.pullRebaseLabel'),
            icon: 'arrow-down',
            disabled: busy,
            onClick: () => void sync('pull', { rebase: true }),
          },
        ]
      : syncMenu?.kind === 'push'
        ? [
            {
              label: t('git.forcePushLabel'),
              icon: 'arrow-up',
              disabled: busy,
              danger: true,
              onClick: () => void forcePush(),
            },
            {
              label: t('git.pushAsMenuLabel'),
              icon: 'cloud-upload',
              disabled: busy || !currentBranch,
              onClick: () => void pushCurrentAs(),
            },
          ]
        : [];

  // BranchTree はカレントブランチ行でも右クリックを許すので、ここで項目別に制御する:
  // 切り替え/マージ 2 種/削除は git 自身も拒否する自明な無効操作なので UI 上も disabled にし、
  // 「名前を変更…」だけはカレントブランチでも動作する (renameBranch 参照) ので有効のままにする。
  //
  // カレント判定は b.current (api.branches(repo.id) が repo.path = メイン worktree の HEAD で
  // 評価した値) ではなく b.name === currentBranch (= worktree.branch。選択中の worktree の HEAD、
  // BranchTree の ✓ 印と同じ値) を使う。リンク worktree ではこの 2 つが食い違い、b.current のまま
  // だと他 worktree がチェックアウト中のブランチを誤って「カレントではない」扱いにして
  // 切り替え/マージ/リベース/削除を実行できてしまう。
  const branchMenuItems = (b: BranchInfo): ContextMenuItem[] => {
    const usedElsewhere = !!b.worktreePath && b.worktreePath !== worktree.path.replace(/\\/g, '/');
    const isCurrent = b.name === currentBranch;
    return [
      {
        label: t('git.switchLabel'),
        icon: 'arrow-swap',
        disabled: busy || usedElsewhere || isCurrent,
        onClick: () =>
          void act(() => api.switchBranch(dir, b.name), t('git.switchedSuccess', { name: b.name })),
      },
      {
        label: t('git.mergeIntoCurrentLabel', { name: b.name }),
        icon: 'git-merge',
        disabled: busy || isCurrent,
        onClick: () => void mergeBranch(b, false),
      },
      {
        label: t('git.ffOnlyMergeLabel'),
        icon: 'git-merge',
        disabled: busy || isCurrent,
        onClick: () => void mergeBranch(b, true),
      },
      {
        label: t('git.rebaseOntoLabel'),
        icon: 'git-branch',
        disabled: busy || isCurrent || operation != null,
        onClick: () => void rebaseOntoBranch(b),
      },
      {
        label: t('git.renameEllipsisLabel'),
        icon: 'edit',
        disabled: busy || usedElsewhere,
        onClick: () => void renameBranch(b),
      },
      {
        label: t('common.remove'),
        icon: 'trash',
        disabled: busy || usedElsewhere || isCurrent,
        danger: true,
        onClick: () => void deleteBranch(b.name),
      },
      {
        label: t('git.fetchFfLabel'),
        icon: 'cloud-download',
        // 非破壊 (早送りのみ・非 FF は git 自身が拒否する) なので ConfirmDialog は挟まない。
        disabled:
          busy ||
          operation != null ||
          !b.upstream ||
          b.upstreamGone ||
          b.upstreamRemote === '.' ||
          usedElsewhere,
        onClick: () =>
          void act(() => api.branchFetchFf(dir, b.name), t('git.fetchFfSuccess', { name: b.name })),
      },
      {
        label: t('git.push'),
        icon: 'cloud-upload',
        // push は作業ツリーに触らないため usedElsewhere では無効化しない。
        disabled: busy || operation != null,
        onClick: () =>
          void act(
            () =>
              api.branchPush(
                dir,
                b.name,
                b.upstreamRemoteRef ? stripHeadsPrefix(b.upstreamRemoteRef) : b.name,
              ),
            t('git.pushedSuccess', { name: b.name }),
          ),
      },
      {
        label: t('git.pushAsMenuLabel'),
        icon: 'cloud-upload',
        disabled: busy || operation != null,
        onClick: () => void pushBranchAs(b),
      },
    ];
  };

  // リモートブランチの削除はリモートに波及する破壊的操作 (元に戻せない) なので
  // ローカル削除と異なり ConfirmDialog(danger) を必須で挟む。
  const deleteRemoteBranch = async (b: BranchInfo) => {
    const ok = await confirmDialog({
      title: t('git.deleteRemoteBranchTitle'),
      message: t('git.deleteRemoteBranchMessage', { name: b.name }),
      confirmLabel: t('common.remove'),
      severity: 'danger',
    });
    if (!ok) return;
    void act(() => api.deleteRemoteBranch(dir, b.name), t('git.deletedSuccess', { name: b.name }));
  };

  const remoteBranchMenuItems = (b: BranchInfo): ContextMenuItem[] => [
    {
      label: t('git.checkoutLabel'),
      icon: 'arrow-swap',
      disabled: busy,
      onClick: () =>
        void act(
          () => api.switchBranchTracking(dir, b.name),
          t('git.trackingBranchCreated', { name: b.name }),
        ),
    },
    {
      label: t('git.deleteRemoteBranchMenuLabel'),
      icon: 'trash',
      disabled: busy,
      danger: true,
      onClick: () => void deleteRemoteBranch(b),
    },
  ];

  // リモート追加は非破壊操作 (重複 name は git 自身が拒否する) なので確認は挟まず、
  // name → URL の 2 段 PromptDialog (usePrompt) だけを通す。
  const addRemote = async () => {
    const name = await promptDialog({
      title: t('git.addRemoteTitle'),
      message: t('git.addRemoteNamePrompt'),
      placeholder: 'origin',
      confirmLabel: t('git.next'),
    });
    if (!name) return;
    const url = await promptDialog({
      title: t('git.addRemoteTitle'),
      message: t('git.addRemoteUrlPrompt', { name }),
      placeholder: 'https://example.com/repo.git',
      confirmLabel: t('common.add'),
    });
    if (!url) return;
    void act(() => api.addRemote(dir, name, url), t('git.addRemoteSuccess', { name }));
  };

  // URL の変更も非破壊操作 (取得済みの remote-tracking ref はそのまま残る) なので、
  // 現在の fetch URL を初期値にした PromptDialog のみで確認なしに実行する。
  const setRemoteUrl = async (r: RemoteInfo) => {
    const url = await promptDialog({
      title: t('git.setRemoteUrlTitle'),
      message: t('git.setRemoteUrlPrompt', { name: r.name }),
      defaultValue: r.fetchUrl,
      confirmLabel: t('git.change'),
    });
    if (!url || url === r.fetchUrl) return;
    void act(() => api.setRemoteUrl(dir, r.name, url), t('git.setRemoteUrlSuccess', { name: r.name }));
  };

  // リモート自体の削除は remote-tracking ref を丸ごと消す破壊的操作なので
  // ConfirmDialog(danger) を必須で挟む (リモートブランチ削除と同じ扱い)。
  const removeRemote = async (r: RemoteInfo) => {
    const ok = await confirmDialog({
      title: t('git.removeRemoteTitle'),
      message: t('git.removeRemoteMessage', { name: r.name }),
      confirmLabel: t('common.remove'),
      severity: 'danger',
    });
    if (!ok) return;
    void act(() => api.removeRemote(dir, r.name), t('git.removeRemoteSuccess', { name: r.name }));
  };

  // タグ名もメッセージも PromptDialog で受ける (メッセージは allowEmpty で省略可)。
  // 取る (空入力を許す必要があるため — PromptDialog は空文字での確定を許さない設計)。
  // メッセージ入力をキャンセル (null) した場合は addRemote の name→url 2 段プロンプトと同様、
  // タグ作成自体を中止する。
  const createTag = async () => {
    const name = await promptDialog({
      title: t('git.newTagTitle'),
      message: t('git.newTagNamePrompt'),
      placeholder: 'v1.0.0',
      confirmLabel: t('git.next'),
    });
    if (!name) return;
    const msg = await promptDialog({
      title: t('git.newTagTitle'),
      message: t('git.newTagMessagePrompt'),
      confirmLabel: t('git.create'),
      allowEmpty: true,
    });
    if (msg === null) return;
    void act(() => api.createTag(dir, name, msg || undefined), t('git.createdSuccess', { name }));
  };

  const pushTag = (tag: TagInfo) => {
    void act(() => api.pushTag(dir, tag.name), t('git.pushTagSuccess', { name: tag.name }));
  };

  // ローカル削除は取り消せないが再作成は容易 (同じ HEAD からいつでも作り直せる) な操作。
  // それでも誤操作防止のため ConfirmDialog(danger) を必須にする (ブランチ削除と同じ扱い)。
  const deleteTagLocal = async (tag: TagInfo) => {
    const ok = await confirmDialog({
      title: t('git.deleteTagTitle'),
      message: t('git.deleteTagLocalMessage', { name: tag.name }),
      confirmLabel: t('common.remove'),
      severity: 'danger',
    });
    if (!ok) return;
    void act(() => api.deleteTag(dir, tag.name), t('git.deletedSuccess', { name: tag.name }));
  };

  // リモートブランチ削除と同じ扱い: リモートに波及する破壊的操作なので ConfirmDialog(danger) 必須。
  const deleteTagRemote = async (tag: TagInfo) => {
    const ok = await confirmDialog({
      title: t('git.deleteTagRemoteTitle'),
      message: t('git.deleteTagRemoteMessage', { name: tag.name }),
      confirmLabel: t('common.remove'),
      severity: 'danger',
    });
    if (!ok) return;
    void act(
      () => api.deleteRemoteTag(dir, tag.name),
      t('git.deleteTagFromOriginSuccess', { name: tag.name }),
    );
  };

  const locals = branches.filter((b) => !b.remote);
  const remotes = branches.filter((b) => b.remote);
  const dirty =
    (worktree.status?.staged ?? 0) +
    (worktree.status?.unstaged ?? 0) +
    (worktree.status?.untracked ?? 0);
  // hard reset (`git reset --hard`) は untracked ファイルを削除しない (実 git で確認済み) ため、
  // HistoryTab の hard reset 警告件数には untracked を含めない (sidebar の `dirty` バッジは
  // 「作業ツリーに何かある」という広い指標のままでよく、意味が異なるので別変数にする。
  // Phase 5 ゲート 5.V の指摘: untracked 込みだと実際に失われる件数より過大表示になっていた)。
  const resetLossCount = (worktree.status?.staged ?? 0) + (worktree.status?.unstaged ?? 0);
  const untrackedCount = worktree.status?.untracked ?? 0;

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
        <p>{t('git.notARepo')}</p>
        <button
          className="primary"
          disabled={busy}
          onClick={() => void act(() => api.gitInit(dir), t('git.gitInitSuccess'))}
        >
          {t('git.runGitInit')}
        </button>
        {message && <div className="git-side-msg">{message}</div>}
      </div>
    );
  }

  // リモート同期バー: 表示中はタイルバーのメインゾーン (右端) へポータルして
  // 1 段化 (モックアップの tpl-git と同配置)。スロット未登録時は従来どおり
  // git-side 先頭にインライン描画するフォールバック。
  const syncBar = (
    <div className={`git-sync-bar${inBar ? ' in-bar' : ''}`}>
          <button
            className="icon-btn git-sync-btn"
            title={t('git.fetchTooltip')}
            disabled={busy}
            onClick={() => void sync('fetch')}
          >
            <span className={`codicon codicon-refresh ${syncing === 'fetch' ? 'spin' : ''}`} />
            {t('git.fetch')}
          </button>
          <button
            className="icon-btn git-sync-btn"
            title={`${t('git.pull')}${worktree.status?.behind ? ` (↓${worktree.status.behind})` : ''}${t('git.pullHint')}`}
            disabled={busy}
            onClick={() => void sync('pull')}
            onContextMenu={(e) => {
              e.preventDefault();
              setSyncMenu({ x: e.clientX, y: e.clientY, kind: 'pull' });
            }}
          >
            <span className={`codicon codicon-arrow-down ${syncing === 'pull' ? 'spin' : ''}`} />
            {t('git.pull')}
            {(worktree.status?.behind ?? 0) > 0 && (
              <span className="sync-count">{worktree.status?.behind}</span>
            )}
          </button>
          <button
            className="icon-btn git-sync-btn"
            title={`${t('git.push')}${worktree.status?.ahead ? ` (↑${worktree.status.ahead})` : ''}${worktree.status?.upstream ? '' : t('git.pushNoUpstreamHint')}${t('git.pushHint')}`}
            disabled={busy}
            onClick={() => void sync('push')}
            onContextMenu={(e) => {
              e.preventDefault();
              setSyncMenu({ x: e.clientX, y: e.clientY, kind: 'push' });
            }}
          >
            <span className={`codicon codicon-arrow-up ${syncing === 'push' ? 'spin' : ''}`} />
            {t('git.push')}
            {(worktree.status?.ahead ?? 0) > 0 && (
              <span className="sync-count">{worktree.status?.ahead}</span>
            )}
          </button>
    </div>
  );

  return (
    <div className="git-tab">
      <div className="git-side">
        {inBar && barSlot ? createPortal(syncBar, barSlot) : syncBar}
        <div className="git-section-head git-section-title">{t('git.workspaceSectionTitle')}</div>
        <div
          className={`git-nav-row ${view === 'status' ? 'active' : ''}`}
          onClick={() => setView('status')}
        >
          <span className="codicon codicon-diff-multiple" /> {t('git.fileStatusNav')}
          {dirty > 0 && <span className="wt-dirty">{dirty}</span>}
        </div>
        <div
          className={`git-nav-row ${view === 'history' ? 'active' : ''}`}
          onClick={() => setView('history')}
        >
          <span className="codicon codicon-history" /> {t('git.historyNav')}
        </div>

        {sectionHead(t('git.branchesSectionTitle'), openLocal, () => setOpenLocal((v) => !v), {
          icon: 'add',
          title: t('git.newBranchTooltip'),
          onClick: () => void createBranch(),
        })}
        {openLocal && (
          <BranchTree
            branches={locals}
            currentBranch={currentBranch}
            worktreePath={worktree.path}
            onContextMenu={openBranchMenu}
          />
        )}

        {sectionHead(t('git.remotesSectionTitle'), openRemote, () => setOpenRemote((v) => !v), {
          icon: 'add',
          title: t('git.addRemoteTitle'),
          onClick: () => void addRemote(),
        })}
        {openRemote && (
          <>
            {gitRemotes.length === 0 ? (
              <div className="git-side-empty">{t('git.noRemotes')}</div>
            ) : (
              gitRemotes.map((r) => (
                <div
                  key={r.name}
                  className="git-branch-row"
                  title={`fetch: ${r.fetchUrl}\npush: ${r.pushUrl}`}
                >
                  <span className="codicon codicon-remote branch-icon" />
                  <span className="branch-name">{r.name}</span>
                  <span className="branch-actions">
                    <button
                      className="icon-btn"
                      title={t('git.editRemoteUrlTooltip')}
                      disabled={busy}
                      onClick={() => void setRemoteUrl(r)}
                    >
                      <span className="codicon codicon-edit" />
                    </button>
                    <button
                      className="icon-btn"
                      title={t('git.deleteEllipsisTooltip')}
                      disabled={busy}
                      onClick={() => void removeRemote(r)}
                    >
                      <span className="codicon codicon-trash" />
                    </button>
                  </span>
                </div>
              ))
            )}
            {remotes.length === 0 ? (
              <div className="git-side-empty">{t('git.noRemoteBranches')}</div>
            ) : (
              <BranchTree branches={remotes} onContextMenu={openBranchMenu} />
            )}
          </>
        )}

        {sectionHead(t('git.stashSectionTitle'), openStash, () => setOpenStash((v) => !v), {
          icon: 'archive',
          title: t('git.stashAllTooltip'),
          onClick: () => void stashCurrent(),
        })}
        {openStash &&
          (stashes.length === 0 ? (
            <div className="git-side-empty">{t('git.noStashes')}</div>
          ) : (
            stashes.map((s) => (
              <div
                key={s.ref}
                className={`git-branch-row git-stash-row ${activeDiff === stashTabKey(s.ref) ? 'selected' : ''}`}
                title={t('git.stashRowTooltip', { ref: s.ref, message: s.message })}
                onClick={() => openStashDiff(s)}
              >
                <span className="codicon codicon-archive branch-icon" />
                <span className="branch-name">{s.message}</span>
                <span className="branch-actions">
                  <button
                    className="icon-btn"
                    title={t('git.stashPopTooltip')}
                    disabled={busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      void act(() => api.stashApply(dir, s.ref, true), t('git.appliedSuccess'));
                    }}
                  >
                    <span className="codicon codicon-debug-step-out" />
                  </button>
                  <button
                    className="icon-btn"
                    title={t('git.stashApplyTooltip')}
                    disabled={busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      void act(() => api.stashApply(dir, s.ref, false), t('git.appliedSuccess'));
                    }}
                  >
                    <span className="codicon codicon-desktop-download" />
                  </button>
                  <button
                    className="icon-btn"
                    title={t('common.remove')}
                    disabled={busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      void (async () => {
                        if (
                          await confirmDialog({
                            title: t('git.stashDropTitle'),
                            message: t('git.stashDropMessage', { ref: s.ref, message: s.message }),
                            confirmLabel: t('common.remove'),
                            severity: 'danger',
                          })
                        ) {
                          void act(() => api.stashDrop(dir, s.ref), t('git.stashDropSuccess'));
                        }
                      })();
                    }}
                  >
                    <span className="codicon codicon-trash" />
                  </button>
                </span>
              </div>
            ))
          ))}

        {sectionHead(t('git.tagsSectionTitle'), openTags, () => setOpenTags((v) => !v), {
          icon: 'add',
          title: t('git.newTagSectionTooltip'),
          onClick: () => void createTag(),
        })}
        {openTags &&
          (tags.length === 0 ? (
            <div className="git-side-empty">{t('git.noTags')}</div>
          ) : (
            tags.map((tag) => (
              <div key={tag.name} className="git-branch-row" title={tag.hash}>
                <span className="codicon codicon-tag branch-icon" />
                <span className="branch-name">{tag.name}</span>
                <span className="branch-actions">
                  <button
                    className="icon-btn"
                    title={t('git.pushToOriginTooltip')}
                    disabled={busy || !!operation}
                    onClick={() => pushTag(tag)}
                  >
                    <span className="codicon codicon-cloud-upload" />
                  </button>
                  <button
                    className="icon-btn"
                    title={t('git.deleteTagLocalTooltip')}
                    disabled={busy || !!operation}
                    onClick={() => void deleteTagLocal(tag)}
                  >
                    <span className="codicon codicon-trash" />
                  </button>
                  <button
                    className="icon-btn"
                    title={t('git.deleteTagRemoteTooltip')}
                    disabled={busy || !!operation}
                    onClick={() => void deleteTagRemote(tag)}
                  >
                    <span className="codicon codicon-cloud" />
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
            <span>
              ⚠ {t('git.operationBanner', { label: t(OPERATION_LABEL_KEYS[operation]) })}
            </span>
            <span className="operation-actions">
              <button className="primary" disabled={busy} onClick={() => void runOperation('continue')}>
                {t('git.continue')}
              </button>
              {!OPERATION_SKIP_UNSUPPORTED.includes(operation) && (
                <button disabled={busy} onClick={() => void runOperation('skip')}>
                  {t('git.skip')}
                </button>
              )}
              <button className="danger" disabled={busy} onClick={() => void runOperation('abort')}>
                {t('git.abort')}
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
                visible={visible}
              />
              <DiffTabsPane
                dir={dir}
                leafId={leafId}
                tabs={diffTabs}
                activeKey={activeDiff}
                reloadKey={reloadKey}
                onActivate={setActiveDiff}
                onClose={(key) => void closeDiff(key)}
                onReload={reloadDiff}
                onStatusChanged={onConflictResolved}
              />
            </div>
          ) : (
            <HistoryTab
              key={`h${reloadKey}`}
              dir={dir}
              operation={operation}
              busy={busy}
              dirty={resetLossCount}
              untracked={untrackedCount}
              onAct={act}
            />
          )}
        </div>
      </div>
      {branchMenu && (
        <ContextMenu
          x={branchMenu.x}
          y={branchMenu.y}
          items={
            branchMenu.branch.remote
              ? remoteBranchMenuItems(branchMenu.branch)
              : branchMenuItems(branchMenu.branch)
          }
          onClose={() => setBranchMenu(null)}
        />
      )}
      {syncMenu && (
        <ContextMenu
          x={syncMenu.x}
          y={syncMenu.y}
          items={syncMenuItems}
          onClose={() => setSyncMenu(null)}
        />
      )}
      {dialog}
      {promptDlg}
    </div>
  );
}
