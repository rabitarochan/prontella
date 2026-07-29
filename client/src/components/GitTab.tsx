import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useDeck } from '../store';
import type {
  BranchInfo,
  GitOperation,
  GitOperationAction,
  RemoteInfo,
  Repo,
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

  // スタッシュの中身 (git stash show -p) は読み取り専用のプレーンテキストタブで開く
  // (StashDiffPane 参照)。競合タブと同じく再クリックで作り直しはしない — 内容は
  // stash@{N} という参照が指す時点のスナップショットで、タブを開いている間に変わる想定が薄い。
  const openStashDiff = useCallback((s: StashEntry) => {
    const key = stashTabKey(s.ref);
    setDiffTabs((prev) =>
      prev.some((t) => t.key === key) ? prev : [...prev, { kind: 'stash', key, ref: s.ref, message: s.message }],
    );
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

  // rename は非破壊操作 (git 自身が名前衝突を拒否する) なので ConfirmDialog は挟まず、
  // 新名の入力だけ PromptDialog (native prompt() の代替) を経由する。
  const renameBranch = async (b: BranchInfo) => {
    const name = await promptDialog({
      title: 'ブランチ名を変更',
      message: `'${b.name}' の新しい名前を入力してください。`,
      defaultValue: b.name,
      confirmLabel: '変更',
    });
    if (!name || name === b.name) return;
    void act(() => api.renameBranch(dir, b.name, name), `${b.name} を ${name} に変更しました`);
  };

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

  // rebase は現在のブランチのコミット列を書き換える操作だが、競合しても abort で rebase 前の
  // HEAD に完全復元できる (Phase 3 の operation 検出が担う) ため danger ではなく normal 確認に
  // する (merge と同じ扱い)。進行中 operation があるとブランチメニューからの多重実行を防ぐため
  // disabled にする (branchMenuItems 側)。
  const rebaseOntoBranch = async (b: BranchInfo) => {
    const target = currentBranch ?? '現在のブランチ';
    const ok = await confirmDialog({
      title: 'リベース',
      message:
        `${target} のコミットを '${b.name}' の上に付け替えます。\n` +
        '競合した場合は競合解決画面に移ります。',
      confirmLabel: 'リベース',
      severity: 'normal',
    });
    if (!ok) return;
    void act(() => api.rebase(dir, b.name), `${b.name} にリベースしました`);
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

  // BranchInfo.upstreamRemoteRef は 'refs/heads/foo' 形式のことも短縮 'foo' のこともある
  // (server 側の for-each-ref フォーマット依存)。server/git.ts に同趣旨のヘルパーがあるが
  // 共有型機構がないためこのファイル内にも小さく複製する。
  const stripHeadsPrefix = (ref: string): string => ref.replace(/^refs\/heads\//, '');

  // 別名プッシュ (-u 相当) はリモート側ブランチ名をユーザーに指定させる。デフォルト値は
  // ローカル名そのまま (自動推測はしない)。既に upstream が設定されている場合のみ、
  // この操作が upstream を書き換えることを実行前に確認する (merge/rebase と同じ severity: 'normal')。
  const pushBranchAs = async (b: BranchInfo) => {
    const name = await promptDialog({
      title: '別名でプッシュ',
      message: `'${b.name}' をプッシュする先のリモートブランチ名を入力してください。`,
      defaultValue: b.name,
      confirmLabel: 'プッシュ',
    });
    if (!name) return;
    if (b.upstream) {
      const remote = b.upstreamRemote ?? 'origin';
      const ok = await confirmDialog({
        title: '別名でプッシュ',
        message:
          `'${b.name}' を ${remote}/${name} にプッシュします。\n` +
          `upstream は '${b.upstream}' から '${remote}/${name}' に変わります。`,
        confirmLabel: 'プッシュ',
        severity: 'normal',
      });
      if (!ok) return;
    }
    void act(() => api.branchPush(dir, b.name, name), `${b.name} を ${name} としてプッシュしました`);
  };

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
        label: '切り替え',
        icon: 'arrow-swap',
        disabled: busy || usedElsewhere || isCurrent,
        onClick: () => void act(() => api.switchBranch(dir, b.name), `${b.name} に切り替えました`),
      },
      {
        label: `'${b.name}' を現在のブランチにマージ (--no-ff)`,
        icon: 'git-merge',
        disabled: busy || isCurrent,
        onClick: () => void mergeBranch(b, false),
      },
      {
        label: 'fast-forward のみでマージ',
        icon: 'git-merge',
        disabled: busy || isCurrent,
        onClick: () => void mergeBranch(b, true),
      },
      {
        label: '現在のブランチをこのブランチにリベース…',
        icon: 'git-branch',
        disabled: busy || isCurrent || operation != null,
        onClick: () => void rebaseOntoBranch(b),
      },
      {
        label: '名前を変更…',
        icon: 'edit',
        disabled: busy || usedElsewhere,
        onClick: () => void renameBranch(b),
      },
      {
        label: '削除',
        icon: 'trash',
        disabled: busy || usedElsewhere || isCurrent,
        danger: true,
        onClick: () => deleteBranch(b.name),
      },
      {
        label: 'upstream からフェッチして早送り',
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
          void act(() => api.branchFetchFf(dir, b.name), `${b.name} を upstream まで進めました`),
      },
      {
        label: 'プッシュ',
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
            `${b.name} をプッシュしました`,
          ),
      },
      {
        label: '別名でプッシュ…',
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
      title: 'リモートブランチを削除',
      message: `'${b.name}' をリモートから削除しますか?\nこの操作はリモートに反映され、元に戻せません。`,
      confirmLabel: '削除',
      severity: 'danger',
    });
    if (!ok) return;
    void act(() => api.deleteRemoteBranch(dir, b.name), `${b.name} を削除しました`);
  };

  const remoteBranchMenuItems = (b: BranchInfo): ContextMenuItem[] => [
    {
      label: 'チェックアウト',
      icon: 'arrow-swap',
      disabled: busy,
      onClick: () =>
        void act(
          () => api.switchBranchTracking(dir, b.name),
          `${b.name} を追跡するローカルブランチを作成しました`,
        ),
    },
    {
      label: 'リモートブランチを削除…',
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
      title: 'リモートを追加',
      message: 'リモート名を入力してください。',
      placeholder: 'origin',
      confirmLabel: '次へ',
    });
    if (!name) return;
    const url = await promptDialog({
      title: 'リモートを追加',
      message: `'${name}' の URL を入力してください。`,
      placeholder: 'https://example.com/repo.git',
      confirmLabel: '追加',
    });
    if (!url) return;
    void act(() => api.addRemote(dir, name, url), `${name} を追加しました`);
  };

  // URL の変更も非破壊操作 (取得済みの remote-tracking ref はそのまま残る) なので、
  // 現在の fetch URL を初期値にした PromptDialog のみで確認なしに実行する。
  const setRemoteUrl = async (r: RemoteInfo) => {
    const url = await promptDialog({
      title: 'リモート URL を変更',
      message: `'${r.name}' の新しい URL を入力してください。`,
      defaultValue: r.fetchUrl,
      confirmLabel: '変更',
    });
    if (!url || url === r.fetchUrl) return;
    void act(() => api.setRemoteUrl(dir, r.name, url), `${r.name} の URL を変更しました`);
  };

  // リモート自体の削除は remote-tracking ref を丸ごと消す破壊的操作なので
  // ConfirmDialog(danger) を必須で挟む (リモートブランチ削除と同じ扱い)。
  const removeRemote = async (r: RemoteInfo) => {
    const ok = await confirmDialog({
      title: 'リモートを削除',
      message: `'${r.name}' を削除しますか?\nこのリモートの追跡ブランチ (${r.name}/*) も一覧から消えます。`,
      confirmLabel: '削除',
      severity: 'danger',
    });
    if (!ok) return;
    void act(() => api.removeRemote(dir, r.name), `${r.name} を削除しました`);
  };

  // タグ名は PromptDialog (必須入力) で、メッセージは stashCurrent と同じ native prompt() で
  // 取る (空入力を許す必要があるため — PromptDialog は空文字での確定を許さない設計)。
  // メッセージ入力をキャンセル (null) した場合は addRemote の name→url 2 段プロンプトと同様、
  // タグ作成自体を中止する。
  const createTag = async () => {
    const name = await promptDialog({
      title: '新しいタグを作成',
      message: 'HEAD にタグを作成します。タグ名を入力してください。',
      placeholder: 'v1.0.0',
      confirmLabel: '次へ',
    });
    if (!name) return;
    const msg = prompt('タグのメッセージ (省略可。入力すると注釈付きタグになります):');
    if (msg === null) return;
    void act(() => api.createTag(dir, name, msg || undefined), `${name} を作成しました`);
  };

  const pushTag = (t: TagInfo) => {
    void act(() => api.pushTag(dir, t.name), `${t.name} を origin に push しました`);
  };

  // ローカル削除は取り消せないが再作成は容易 (同じ HEAD からいつでも作り直せる) な操作。
  // それでも誤操作防止のため ConfirmDialog(danger) を必須にする (ブランチ削除と同じ扱い)。
  const deleteTagLocal = async (t: TagInfo) => {
    const ok = await confirmDialog({
      title: 'タグを削除',
      message: `'${t.name}' をローカルから削除しますか?`,
      confirmLabel: '削除',
      severity: 'danger',
    });
    if (!ok) return;
    void act(() => api.deleteTag(dir, t.name), `${t.name} を削除しました`);
  };

  // リモートブランチ削除と同じ扱い: リモートに波及する破壊的操作なので ConfirmDialog(danger) 必須。
  const deleteTagRemote = async (t: TagInfo) => {
    const ok = await confirmDialog({
      title: 'リモートのタグを削除',
      message: `'${t.name}' を origin から削除しますか?\nこの操作はリモートに反映され、元に戻せません。`,
      confirmLabel: '削除',
      severity: 'danger',
    });
    if (!ok) return;
    void act(() => api.deleteRemoteTag(dir, t.name), `${t.name} を origin から削除しました`);
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

        {sectionHead('リモート', openRemote, () => setOpenRemote((v) => !v), {
          icon: 'add',
          title: 'リモートを追加',
          onClick: () => void addRemote(),
        })}
        {openRemote && (
          <>
            {gitRemotes.length === 0 ? (
              <div className="git-side-empty">リモートはありません</div>
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
                      title="URL を変更…"
                      disabled={busy}
                      onClick={() => void setRemoteUrl(r)}
                    >
                      <span className="codicon codicon-edit" />
                    </button>
                    <button
                      className="icon-btn"
                      title="削除…"
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
              <div className="git-side-empty">リモートブランチはありません</div>
            ) : (
              <BranchTree branches={remotes} onContextMenu={openBranchMenu} />
            )}
          </>
        )}

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
              <div
                key={s.ref}
                className={`git-branch-row git-stash-row ${activeDiff === stashTabKey(s.ref) ? 'selected' : ''}`}
                title={`${s.ref}: ${s.message} — クリックで差分を表示`}
                onClick={() => openStashDiff(s)}
              >
                <span className="codicon codicon-archive branch-icon" />
                <span className="branch-name">{s.message}</span>
                <span className="branch-actions">
                  <button
                    className="icon-btn"
                    title="適用して削除 (pop)"
                    disabled={busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      void act(() => api.stashApply(dir, s.ref, true), '適用しました');
                    }}
                  >
                    <span className="codicon codicon-debug-step-out" />
                  </button>
                  <button
                    className="icon-btn"
                    title="適用 (スタッシュは残す)"
                    disabled={busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      void act(() => api.stashApply(dir, s.ref, false), '適用しました');
                    }}
                  >
                    <span className="codicon codicon-desktop-download" />
                  </button>
                  <button
                    className="icon-btn"
                    title="削除"
                    disabled={busy}
                    onClick={(e) => {
                      e.stopPropagation();
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

        {sectionHead('タグ', openTags, () => setOpenTags((v) => !v), {
          icon: 'add',
          title: '新しいタグを作成 (HEAD)',
          onClick: () => void createTag(),
        })}
        {openTags &&
          (tags.length === 0 ? (
            <div className="git-side-empty">タグはありません</div>
          ) : (
            tags.map((t) => (
              <div key={t.name} className="git-branch-row" title={t.hash}>
                <span className="codicon codicon-tag branch-icon" />
                <span className="branch-name">{t.name}</span>
                <span className="branch-actions">
                  <button
                    className="icon-btn"
                    title="origin へ push"
                    disabled={busy || !!operation}
                    onClick={() => pushTag(t)}
                  >
                    <span className="codicon codicon-cloud-upload" />
                  </button>
                  <button
                    className="icon-btn"
                    title="ローカルタグを削除…"
                    disabled={busy || !!operation}
                    onClick={() => void deleteTagLocal(t)}
                  >
                    <span className="codicon codicon-trash" />
                  </button>
                  <button
                    className="icon-btn"
                    title="リモート (origin) から削除…"
                    disabled={busy || !!operation}
                    onClick={() => void deleteTagRemote(t)}
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
      {dialog}
      {promptDlg}
    </div>
  );
}
