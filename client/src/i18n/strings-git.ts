import type { Lang } from './langStore';

// Git 系 (GitTab / 変更 / 履歴 / diff / 競合解決 / モーダル) の文字列。
// strings.ts でマージされる。

export const GIT_STRINGS = {
  // ---- git 共通アクション語 (複数コンポーネントで再利用) ----
  'git.discard': { ja: '破棄', en: 'Discard' },
  'git.create': { ja: '作成', en: 'Create' },
  'git.change': { ja: '変更', en: 'Change' },
  'git.next': { ja: '次へ', en: 'Next' },
  'git.merge': { ja: 'マージ', en: 'Merge' },
  'git.rebase': { ja: 'リベース', en: 'Rebase' },
  'git.cherryPick': { ja: 'チェリーピック', en: 'Cherry-pick' },
  'git.revert': { ja: 'リバート', en: 'Revert' },
  'git.stash': { ja: 'スタッシュ', en: 'Stash' },
  'git.abort': { ja: '中止', en: 'Abort' },
  'git.continue': { ja: '続行', en: 'Continue' },
  'git.skip': { ja: 'スキップ', en: 'Skip' },
  'git.resolve': { ja: '解決', en: 'Resolve' },
  'git.push': { ja: 'プッシュ', en: 'Push' },
  'git.pull': { ja: 'プル', en: 'Pull' },
  'git.fetch': { ja: 'フェッチ', en: 'Fetch' },
  'git.cannotUndo': { ja: '※ 元に戻せません', en: 'This cannot be undone.' },
  'git.scrollToTooltip': { ja: 'この位置へスクロール', en: 'Scroll to this position' },
  'git.noCommitHistory': {
    ja: 'このファイルのコミット履歴はありません',
    en: 'This file has no commit history.',
  },
  'git.createdSuccess': { ja: '{name} を作成しました', en: 'Created {name}.' },
  'git.deletedSuccess': { ja: '{name} を削除しました', en: 'Deleted {name}.' },

  // ---- GitTab: 進行中操作 (merge/rebase/cherry-pick/revert) バナー ----
  'git.operationAbortTitle': { ja: '{label}を中止', en: 'Abort {label}' },
  'git.operationAbortMessage': {
    ja: '進行中の{label}を中止して元の状態に戻します。よろしいですか?',
    en: 'This will abort the in-progress {label} and restore the original state. Continue?',
  },
  'git.operationAbortSuccess': { ja: '{label}を中止しました', en: '{label} aborted.' },
  'git.operationSkipSuccess': {
    ja: '{label}を 1 件スキップしました',
    en: 'Skipped one step of {label}.',
  },
  'git.operationContinueSuccess': { ja: '{label}を続行しました', en: 'Continued {label}.' },
  'git.operationBanner': {
    ja: '{label}進行中 — コンフリクトを解決してから続行してください',
    en: '{label} in progress — resolve conflicts, then continue',
  },

  // ---- GitTab: diff タブ (競合) を閉じる確認 ----
  'git.closeConflictTitle': { ja: '競合の解決を閉じる', en: 'Close conflict resolution' },
  'git.closeConflictMessage': {
    ja: '{path} の解決作業を破棄して閉じますか?',
    en: 'Discard the resolution work for {path} and close it?',
  },
  'git.discardAndCloseLabel': { ja: '破棄して閉じる', en: 'Discard and close' },

  // ---- GitTab: ブランチ作成/削除/名前変更 ----
  'git.createBranchTitle': { ja: 'ブランチを作成', en: 'Create branch' },
  'git.createBranchPrompt': {
    ja: '新しいブランチ名 (現在の HEAD から作成して切り替え):',
    en: 'New branch name (created from and switched to the current HEAD):',
  },
  'git.deleteBranchTitle': { ja: 'ブランチを削除', en: 'Delete branch' },
  'git.deleteBranchMessage': { ja: 'ブランチ {name} を削除しますか?', en: 'Delete branch {name}?' },
  'git.forceDeleteBranchTitle': { ja: 'ブランチを強制削除', en: 'Force-delete branch' },
  'git.forceDeleteBranchMessage': {
    ja: '削除に失敗しました:\n{message}\n\nマージされていないコミットごと強制削除しますか?',
    en: 'Deletion failed:\n{message}\n\nForce-delete including unmerged commits?',
  },
  'git.forceDelete': { ja: '強制削除', en: 'Force delete' },
  'git.branchDeletedSuccess': { ja: 'ブランチを削除しました', en: 'Deleted the branch.' },
  'git.renameBranchTitle': { ja: 'ブランチ名を変更', en: 'Rename branch' },
  'git.renameBranchPrompt': {
    ja: "'{name}' の新しい名前を入力してください。",
    en: "Enter a new name for '{name}'.",
  },
  'git.renameBranchSuccess': {
    ja: '{old} を {new} に変更しました',
    en: 'Renamed {old} to {new}.',
  },

  // ---- GitTab: マージ / リベース ----
  'git.currentBranchFallback': { ja: '現在のブランチ', en: 'the current branch' },
  'git.mergeFfOnlyMessage': {
    ja: "'{name}' を {target} に fast-forward のみでマージしますか?",
    en: "Merge '{name}' into {target} using fast-forward only?",
  },
  'git.mergeMessage': {
    ja: "'{name}' を {target} にマージしますか? (--no-ff)",
    en: "Merge '{name}' into {target}? (--no-ff)",
  },
  'git.mergedSuccess': { ja: 'マージしました', en: 'Merged.' },
  'git.rebaseMessage': {
    ja: "{target} のコミットを '{name}' の上に付け替えます。\n競合した場合は競合解決画面に移ります。",
    en: "This replays {target}'s commits onto '{name}'.\nIf conflicts occur, you'll be taken to the conflict resolution screen.",
  },
  'git.rebasedSuccess': { ja: '{name} にリベースしました', en: 'Rebased onto {name}.' },

  // ---- GitTab: リモート同期 (fetch/pull/push) ----
  'git.fetchTooltip': {
    ja: 'フェッチ (git fetch --all --prune)',
    en: 'Fetch (git fetch --all --prune)',
  },
  'git.pullHint': { ja: ' (右クリック: rebase でプル)', en: ' (right-click: pull with rebase)' },
  'git.pushNoUpstreamHint': {
    ja: ' — upstream 未設定のため -u origin で公開',
    en: ' — no upstream set; will publish with -u origin',
  },
  'git.pushHint': {
    ja: ' (右クリック: force-with-lease でプッシュ)',
    en: ' (right-click: force-with-lease push)',
  },
  'git.fetchedSuccess': { ja: 'フェッチしました', en: 'Fetched.' },
  'git.pulledSuccess': { ja: 'プルしました', en: 'Pulled.' },
  'git.pushedGenericSuccess': { ja: 'プッシュしました', en: 'Pushed.' },
  'git.forcePushLabel': { ja: 'force-with-lease でプッシュ', en: 'Push with force-with-lease' },
  'git.forcePushMessage': {
    ja: 'リモートの履歴を書き換えます (--force-with-lease)。よろしいですか?',
    en: 'This rewrites remote history (--force-with-lease). Continue?',
  },
  'git.pullRebaseLabel': { ja: 'rebase でプル', en: 'Pull with rebase' },
  'git.pushAsMenuLabel': { ja: '別名でプッシュ…', en: 'Push as…' },
  'git.pushAsTitle': { ja: '別名でプッシュ', en: 'Push as' },
  'git.pushAsPromptMessage': {
    ja: "'{name}' をプッシュする先のリモートブランチ名を入力してください。",
    en: "Enter the remote branch name to push '{name}' to.",
  },
  'git.pushAsConfirmMessage': {
    ja: "'{name}' を {ref} にプッシュします。\nupstream は '{upstream}' から '{ref}' に変わります。",
    en: "This pushes '{name}' to {ref}.\nThe upstream will change from '{upstream}' to '{ref}'.",
  },
  'git.pushAsSuccess': { ja: '{name} を {as} としてプッシュしました', en: 'Pushed {name} as {as}.' },
  'git.pushCurrentAsConfirmMessage': {
    ja: "'{name}' をリモート側の '{as}' へプッシュします。\nupstream は '{upstream}' から '{as}' を指すよう変わります。",
    en: "This pushes '{name}' to the remote branch '{as}'.\nThe upstream will change from '{upstream}' to point to '{as}'.",
  },

  // ---- GitTab: ブランチメニュー ----
  'git.switchLabel': { ja: '切り替え', en: 'Switch' },
  'git.switchedSuccess': { ja: '{name} に切り替えました', en: 'Switched to {name}.' },
  'git.mergeIntoCurrentLabel': {
    ja: "'{name}' を現在のブランチにマージ (--no-ff)",
    en: "Merge '{name}' into the current branch (--no-ff)",
  },
  'git.ffOnlyMergeLabel': { ja: 'fast-forward のみでマージ', en: 'Merge fast-forward only' },
  'git.rebaseOntoLabel': {
    ja: '現在のブランチをこのブランチにリベース…',
    en: 'Rebase the current branch onto this branch…',
  },
  'git.renameEllipsisLabel': { ja: '名前を変更…', en: 'Rename…' },
  'git.fetchFfLabel': { ja: 'upstream からフェッチして早送り', en: 'Fetch and fast-forward from upstream' },
  'git.fetchFfSuccess': {
    ja: '{name} を upstream まで進めました',
    en: 'Fast-forwarded {name} to upstream.',
  },
  'git.pushedSuccess': { ja: '{name} をプッシュしました', en: 'Pushed {name}.' },
  'git.checkoutLabel': { ja: 'チェックアウト', en: 'Check out' },
  'git.trackingBranchCreated': {
    ja: '{name} を追跡するローカルブランチを作成しました',
    en: 'Created a local branch tracking {name}.',
  },
  'git.deleteRemoteBranchMenuLabel': { ja: 'リモートブランチを削除…', en: 'Delete remote branch…' },
  'git.deleteRemoteBranchTitle': { ja: 'リモートブランチを削除', en: 'Delete remote branch' },
  'git.deleteRemoteBranchMessage': {
    ja: "'{name}' をリモートから削除しますか?\nこの操作はリモートに反映され、元に戻せません。",
    en: "Delete '{name}' from the remote?\nThis affects the remote and cannot be undone.",
  },

  // ---- GitTab: リモート管理 ----
  'git.addRemoteTitle': { ja: 'リモートを追加', en: 'Add remote' },
  'git.addRemoteNamePrompt': { ja: 'リモート名を入力してください。', en: 'Enter a remote name.' },
  'git.addRemoteUrlPrompt': {
    ja: "'{name}' の URL を入力してください。",
    en: "Enter the URL for '{name}'.",
  },
  'git.addRemoteSuccess': { ja: '{name} を追加しました', en: 'Added {name}.' },
  'git.setRemoteUrlTitle': { ja: 'リモート URL を変更', en: 'Change remote URL' },
  'git.setRemoteUrlPrompt': {
    ja: "'{name}' の新しい URL を入力してください。",
    en: "Enter a new URL for '{name}'.",
  },
  'git.setRemoteUrlSuccess': {
    ja: '{name} の URL を変更しました',
    en: 'Changed the URL for {name}.',
  },
  'git.removeRemoteTitle': { ja: 'リモートを削除', en: 'Remove remote' },
  'git.removeRemoteMessage': {
    ja: "'{name}' を削除しますか?\nこのリモートの追跡ブランチ ({name}/*) も一覧から消えます。",
    en: "Remove '{name}'?\nThis remote's tracking branches ({name}/*) will also disappear from the list.",
  },
  'git.removeRemoteSuccess': { ja: '{name} を削除しました', en: 'Removed {name}.' },

  // ---- GitTab: タグ管理 ----
  'git.newTagTitle': { ja: '新しいタグを作成', en: 'Create new tag' },
  'git.newTagNamePrompt': {
    ja: 'HEAD にタグを作成します。タグ名を入力してください。',
    en: 'Create a tag at HEAD. Enter a tag name.',
  },
  'git.newTagMessagePrompt': {
    ja: 'タグのメッセージ (省略可。入力すると注釈付きタグになります):',
    en: 'Tag message (optional; entering one creates an annotated tag):',
  },
  'git.pushTagSuccess': { ja: '{name} を origin に push しました', en: 'Pushed {name} to origin.' },
  'git.deleteTagTitle': { ja: 'タグを削除', en: 'Delete tag' },
  'git.deleteTagLocalMessage': {
    ja: "'{name}' をローカルから削除しますか?",
    en: "Delete '{name}' locally?",
  },
  'git.deleteTagRemoteTitle': { ja: 'リモートのタグを削除', en: 'Delete remote tag' },
  'git.deleteTagRemoteMessage': {
    ja: "'{name}' を origin から削除しますか?\nこの操作はリモートに反映され、元に戻せません。",
    en: "Delete '{name}' from origin?\nThis affects the remote and cannot be undone.",
  },
  'git.deleteTagFromOriginSuccess': {
    ja: '{name} を origin から削除しました',
    en: 'Deleted {name} from origin.',
  },

  // ---- GitTab: サイドバー構成 (セクション見出し/ナビ) ----
  'git.workspaceSectionTitle': { ja: 'ワークスペース', en: 'Workspace' },
  'git.fileStatusNav': { ja: 'ファイルステータス', en: 'File status' },
  'git.historyNav': { ja: '履歴', en: 'History' },
  'git.branchesSectionTitle': { ja: 'ブランチ', en: 'Branches' },
  'git.newBranchTooltip': { ja: '新しいブランチを作成', en: 'Create new branch' },
  'git.remotesSectionTitle': { ja: 'リモート', en: 'Remotes' },
  'git.noRemotes': { ja: 'リモートはありません', en: 'No remotes.' },
  'git.noRemoteBranches': { ja: 'リモートブランチはありません', en: 'No remote branches.' },
  'git.editRemoteUrlTooltip': { ja: 'URL を変更…', en: 'Change URL…' },
  'git.deleteEllipsisTooltip': { ja: '削除…', en: 'Delete…' },
  'git.stashSectionTitle': { ja: 'スタッシュ', en: 'Stash' },
  'git.stashAllTooltip': {
    ja: '現在の変更をスタッシュ (未追跡ファイル含む)',
    en: 'Stash current changes (including untracked files)',
  },
  'git.stashMessagePrompt': { ja: 'スタッシュのメッセージ (省略可):', en: 'Stash message (optional):' },
  'git.stashedSuccess': { ja: 'スタッシュしました', en: 'Stashed.' },
  'git.noStashes': { ja: 'スタッシュはありません', en: 'No stashes.' },
  'git.stashRowTooltip': {
    ja: '{ref}: {message} — クリックで差分を表示',
    en: '{ref}: {message} — click to view the diff',
  },
  'git.stashPopTooltip': { ja: '適用して削除 (pop)', en: 'Apply and drop (pop)' },
  'git.appliedSuccess': { ja: '適用しました', en: 'Applied.' },
  'git.stashApplyTooltip': { ja: '適用 (スタッシュは残す)', en: 'Apply (keep the stash)' },
  'git.stashDropTitle': { ja: 'スタッシュを削除', en: 'Delete stash' },
  'git.stashDropMessage': { ja: '{ref} を削除しますか?\n{message}', en: 'Delete {ref}?\n{message}' },
  'git.stashDropSuccess': { ja: '削除しました', en: 'Deleted.' },
  'git.tagsSectionTitle': { ja: 'タグ', en: 'Tags' },
  'git.newTagSectionTooltip': { ja: '新しいタグを作成 (HEAD)', en: 'Create new tag (HEAD)' },
  'git.noTags': { ja: 'タグはありません', en: 'No tags.' },
  'git.pushToOriginTooltip': { ja: 'origin へ push', en: 'Push to origin' },
  'git.deleteTagLocalTooltip': { ja: 'ローカルタグを削除…', en: 'Delete local tag…' },
  'git.deleteTagRemoteTooltip': { ja: 'リモート (origin) から削除…', en: 'Delete from remote (origin)…' },

  // ---- GitTab: Git リポジトリーでない場合 ----
  'git.notARepo': { ja: 'Git リポジトリーではありません', en: 'Not a Git repository.' },
  'git.runGitInit': { ja: 'git init を実行', en: 'Run git init' },
  'git.gitInitSuccess': { ja: 'git init を実行しました', en: 'Ran git init.' },

  // ---- ChangesTab ----
  'changes.discardUntrackedTitle': { ja: 'この未追跡ファイルを削除', en: 'Delete this untracked file' },
  'changes.discardTrackedTitle': { ja: 'この変更を破棄', en: 'Discard this change' },
  'changes.discardUntrackedMessage': {
    ja: 'この未追跡ファイルを削除しますか?\n{path}\n\n※ 元に戻せません',
    en: 'Delete this untracked file?\n{path}\n\nThis cannot be undone.',
  },
  'changes.discardTrackedMessage': {
    ja: 'この変更を破棄しますか?\n{path}\n\n※ 元に戻せません',
    en: 'Discard this change?\n{path}\n\nThis cannot be undone.',
  },
  'changes.lastCommitLine': {
    ja: '\n\n直前のコミット: {hash} {subject}',
    en: '\n\nPrevious commit: {hash} {subject}',
  },
  'changes.undoLastCommitTitle': { ja: '直前のコミットを取り消す', en: 'Undo the previous commit' },
  'changes.undoLastCommitMessage': {
    ja: '直前のコミットを取り消しますか?(reset --soft HEAD~1)\n変更はステージ済みとして残ります。{lastCommitLine}',
    en: 'Undo the previous commit? (reset --soft HEAD~1)\nChanges will remain staged.{lastCommitLine}',
  },
  'changes.undoConfirm': { ja: '取り消す', en: 'Undo' },
  'changes.discardAllTitle': { ja: 'すべての変更を破棄', en: 'Discard all changes' },
  'changes.discardAllMessage': {
    ja: '変更ファイル {n} 件の作業ツリーの変更を破棄します。',
    en: 'This discards working-tree changes in {n} changed files.',
  },
  'changes.discardAllUntrackedToggle': {
    ja: '未追跡ファイルも削除する ({n} 件)',
    en: 'Also delete untracked files ({n})',
  },
  'changes.conflictRowTooltip': {
    ja: '{path} — クリックで競合を解決',
    en: '{path} — click to resolve the conflict',
  },
  'changes.diffRowTooltip': {
    ja: '{path} — クリックで差分をタブ表示',
    en: '{path} — click to open the diff in a tab',
  },
  'changes.deleteFileTooltip': { ja: 'ファイルを削除', en: 'Delete file' },
  'changes.discardChangeTooltip': { ja: '変更を破棄', en: 'Discard change' },
  'changes.unstageTooltip': { ja: 'ステージ解除', en: 'Unstage' },
  'changes.stageTooltip': { ja: 'ステージ', en: 'Stage' },
  'changes.stagedSectionTitle': { ja: 'ステージ済み ({n})', en: 'Staged ({n})' },
  'changes.unstageAllTooltip': { ja: 'すべてステージ解除', en: 'Unstage all' },
  'changes.unstagedSectionTitle': { ja: '変更 ({n})', en: 'Changes ({n})' },
  'changes.discardAllTooltip': { ja: 'すべて破棄', en: 'Discard all' },
  'changes.stageAllTooltip': { ja: 'すべてステージ', en: 'Stage all' },
  'changes.empty': { ja: '変更はありません', en: 'No changes.' },
  'changes.commitMessagePlaceholder': { ja: 'コミットメッセージ', en: 'Commit message' },
  'changes.amendToggle': { ja: '直前のコミットを修正 (--amend)', en: 'Amend the previous commit (--amend)' },
  'changes.amendCommitButton': { ja: 'コミットを修正', en: 'Amend commit' },
  'changes.commitButton': { ja: 'コミット ({n} ファイル)', en: 'Commit ({n} files)' },

  // ---- HistoryTab ----
  'history.colTree': { ja: 'ツリー', en: 'Tree' },
  'history.colSubject': { ja: '説明', en: 'Subject' },
  'history.colCommit': { ja: 'コミット', en: 'Commit' },
  'history.colAuthor': { ja: '作者', en: 'Author' },
  'history.colDate': { ja: '日時', en: 'Date' },
  'history.showAllBranches': { ja: '全ブランチを表示 (--all)', en: 'Show all branches (--all)' },
  'history.filterMessage': { ja: 'メッセージ', en: 'Message' },
  'history.filterAuthor': { ja: '著者', en: 'Author' },
  'history.filterPath': { ja: 'パス', en: 'Path' },
  'history.filterPlaceholderAuthor': { ja: '著者名で絞り込み', en: 'Filter by author name' },
  'history.filterPlaceholderPath': { ja: 'パスで絞り込み', en: 'Filter by path' },
  'history.filterPlaceholderMessage': { ja: 'メッセージで絞り込み', en: 'Filter by message' },
  'history.clearFilterTooltip': { ja: 'フィルターをクリア', en: 'Clear the filter' },
  'history.commitCount': { ja: '{n} コミット', en: '{n} commits' },
  'history.filteringSuffix': { ja: ' (絞り込み中)', en: ' (filtered)' },
  'history.noMatchingCommits': { ja: '一致するコミットがありません', en: 'No matching commits.' },
  'history.noCommits': { ja: 'コミットがありません', en: 'No commits.' },
  'history.selectCommitHint': { ja: 'コミットを選択すると詳細を表示します', en: 'Select a commit to view details.' },
  'history.selectFileHint': {
    ja: 'ファイルを選択すると差分を表示します',
    en: 'Select a file to view its diff.',
  },
  'history.resetMessage': {
    ja: 'HEAD を {hash} ({subject}) まで戻します ({mode})。',
    en: 'This moves HEAD back to {hash} ({subject}) ({mode}).',
  },
  'history.resetHardLossWarning': {
    ja: '※ 未コミットの変更 {n} 件が失われます。',
    en: '※ {n} uncommitted changes will be lost.',
  },
  'history.resetHardUntrackedKept': {
    ja: '※ 未追跡ファイル {n} 件は保持されます。',
    en: '※ {n} untracked files will be kept.',
  },
  'history.resetSuccess': { ja: '{hash} まで reset しました ({mode})', en: 'Reset to {hash} ({mode}).' },
  'history.cherryPickMessage': {
    ja: "'{hash}' ({subject}) を現在のブランチに適用しますか?",
    en: "Apply '{hash}' ({subject}) to the current branch?",
  },
  'history.cherryPickSuccess': { ja: '{hash} をチェリーピックしました', en: 'Cherry-picked {hash}.' },
  'history.revertMessage': {
    ja: "'{hash}' ({subject}) を打ち消すコミットを作成しますか?",
    en: "Create a commit that reverts '{hash}' ({subject})?",
  },
  'history.revertSuccess': { ja: '{hash} をリバートしました', en: 'Reverted {hash}.' },
  'history.resetToHereLabel': { ja: 'ここまで reset ({mode})…', en: 'Reset to here ({mode})…' },
  'history.cherryPickMenuLabel': { ja: 'このコミットをチェリーピック…', en: 'Cherry-pick this commit…' },
  'history.revertMenuLabel': { ja: 'このコミットをリバート…', en: 'Revert this commit…' },

  // ---- BranchTree ----
  'branch.usedElsewhereTooltip': { ja: '他の Worktree で使用中', en: 'In use by another worktree' },
  'branch.upstreamGoneTooltip': { ja: 'upstream が見つかりません', en: 'Upstream not found' },

  // ---- DiffPane ----
  'diff.binaryUnsupported': {
    ja: 'バイナリファイルは差分表示できません',
    en: 'Cannot show a diff for binary files.',
  },
  'diff.tooLarge': { ja: 'ファイルが大きすぎます (2MB 超)', en: 'File is too large (over 2MB).' },
  'diff.noDiff': { ja: '差分はありません', en: 'No diff.' },

  // ---- DiffTabsPane ----
  'difftabs.empty': {
    ja: 'ファイルを選択すると差分をタブで表示します',
    en: 'Select a file to view its diff in a tab.',
  },
  'difftabs.titleStaged': { ja: ' (ステージ済みの変更)', en: ' (staged changes)' },
  'difftabs.titleConflict': { ja: ' (競合の解決)', en: ' (conflict resolution)' },
  'difftabs.stagedScopeLabel': {
    ja: 'ステージ済みの変更 (HEAD ↔ インデックス)',
    en: 'Staged changes (HEAD ↔ index)',
  },
  'difftabs.unstagedScopeLabel': {
    ja: '未ステージの変更 (インデックス ↔ 作業ツリー)',
    en: 'Unstaged changes (index ↔ working tree)',
  },
  'difftabs.reloadTooltip': { ja: '差分を取り直す', en: 'Refresh the diff' },
  'difftabs.stashScopeLabel': { ja: 'スタッシュの差分 (読み取り専用)', en: 'Stash diff (read-only)' },

  // ---- DiffHunkStrip ----
  'hunk.reloadedNotice': {
    ja: '差分が変化したため再読み込みしました',
    en: 'The diff changed, so it was reloaded.',
  },
  'hunk.discardTitle': { ja: 'ハンクを破棄', en: 'Discard hunk' },
  'hunk.discardMessage': {
    ja: 'この変更を破棄しますか?\n{header}\n\n※ 元に戻せません',
    en: 'Discard this change?\n{header}\n\nThis cannot be undone.',
  },
  'hunk.stageTooltip': { ja: 'このハンクをステージ', en: 'Stage this hunk' },
  'hunk.discardTooltip': { ja: 'このハンクを破棄', en: 'Discard this hunk' },
  'hunk.unstageTooltip': { ja: 'このハンクをステージ解除', en: 'Unstage this hunk' },
  'hunk.collapseLinesTooltip': { ja: '行選択を閉じる', en: 'Close line selection' },
  'hunk.selectLinesTooltip': { ja: '行を選択', en: 'Select lines' },
  'hunk.discardLinesTitle': { ja: '選択した行を破棄', en: 'Discard selected lines' },
  'hunk.discardLinesMessage': {
    ja: '選択した {n} 行を破棄しますか?\n{header}\n\n{warning}※ 元に戻せません',
    en: 'Discard the selected {n} lines?\n{header}\n\n{warning}This cannot be undone.',
  },
  'hunk.eofWarning': {
    ja: '※ このハンクは末尾に改行がない変更を含むため、選択した行に加えて関連する行末の変更も一緒に戻る場合があります\n',
    en: '※ This hunk includes a change with no trailing newline, so lines related to your selection may also be reverted.\n',
  },
  'hunk.stageLinesButton': { ja: '選択行をステージ', en: 'Stage selected lines' },
  'hunk.discardLinesButton': { ja: '選択行を破棄', en: 'Discard selected lines' },
  'hunk.unstageLinesButton': { ja: '選択行をステージ解除', en: 'Unstage selected lines' },

  // ---- ConflictResolvePane ----
  'conflict.sideOurs': { ja: '現在のブランチ側 (ours)', en: 'Current branch side (ours)' },
  'conflict.sideTheirs': { ja: 'マージ相手側 (theirs)', en: 'Incoming side (theirs)' },
  'conflict.resolveWholeTitle': { ja: 'ファイル全体を {side} で解決', en: 'Resolve entire file with {side}' },
  'conflict.resolveWholeMessage': {
    ja: '{path} の内容全体を{sideLabel}で上書きします(自動的にステージされます)。',
    en: 'Overwrite the entire content of {path} with {sideLabel} (this will be staged automatically).',
  },
  'conflict.unsavedWillBeDiscarded': {
    ja: '※ エディター上の未保存の編集は破棄されます。',
    en: '※ Unsaved edits in the editor will be discarded.',
  },
  'conflict.resolvedSideSuccess': {
    ja: '{side} で解決しました (ステージ済み)',
    en: '{side} resolved (staged).',
  },
  'conflict.savedAndStagedSuccess': { ja: '保存してステージしました', en: 'Saved and staged.' },
  'conflict.unresolvedCount': { ja: '未解決の競合 {n} 件', en: '{n} unresolved conflicts' },
  'conflict.noMarkers': { ja: '競合マーカーなし', en: 'No conflict markers' },
  'conflict.blockLabel': { ja: '競合 {n}', en: 'Conflict {n}' },
  'conflict.applyOursTooltip': { ja: 'この行をours採用', en: 'Apply this line as ours' },
  'conflict.applyTheirsTooltip': { ja: 'この行をtheirs採用', en: 'Apply this line as theirs' },
  'conflict.applyBothTooltip': { ja: 'ours→theirsの順で両方残す', en: 'Keep both, ours then theirs' },
  'conflict.binaryMessage': {
    ja: 'バイナリファイルは表示できません ({size} bytes)。「ファイル全体を ours/theirs」で解決してください',
    en: 'Cannot display binary files ({size} bytes). Resolve using "Resolve entire file with ours/theirs".',
  },
  'conflict.tooLargeMessage': {
    ja: 'ファイルが大きすぎます ({size} KB)。「ファイル全体を ours/theirs」で解決してください',
    en: 'File is too large ({size} KB). Resolve using "Resolve entire file with ours/theirs".',
  },
  'conflict.resolveOursButton': { ja: 'ファイル全体を ours で解決', en: 'Resolve entire file with ours' },
  'conflict.resolveTheirsButton': { ja: 'ファイル全体を theirs で解決', en: 'Resolve entire file with theirs' },
  'conflict.unresolvedRemainingTooltip': {
    ja: '未解決の競合が {n} 件残っています',
    en: '{n} unresolved conflicts remain',
  },
  'conflict.resolvedButton': { ja: '解決済み (保存してステージ)', en: 'Resolved (save and stage)' },

  // ---- StashDiffPane ----
  'stashdiff.noDiff': { ja: '差分はありません (tracked な変更なし)', en: 'No diff (no tracked changes).' },
  'stashdiff.truncated': {
    ja: '差分が大きすぎるため以降を省略しています (2MB を超えています)',
    en: 'Diff is too large; the rest is omitted (over 2MB).',
  },

  // ---- AddWorktreeModal ----
  'addWorktree.title': { ja: 'Worktree を追加 — {name}', en: 'Add worktree — {name}' },
  'addWorktree.newBranchOption': { ja: '新しいブランチを作成', en: 'Create a new branch' },
  'addWorktree.existingBranchOption': { ja: '既存のブランチ', en: 'Existing branch' },
  'addWorktree.branchNameLabel': { ja: 'ブランチ名', en: 'Branch name' },
  'addWorktree.baseLabel': { ja: '作成元 (base)', en: 'Base' },
  'addWorktree.branchLabel': { ja: 'ブランチ', en: 'Branch' },
  'addWorktree.inUseSuffix': { ja: ' (使用中)', en: ' (in use)' },
  'addWorktree.pathLabel': { ja: 'パス (省略可)', en: 'Path (optional)' },
  'addWorktree.pathPlaceholder': {
    ja: '既定: ../{name}.worktrees/<ブランチ名>',
    en: 'Default: ../{name}.worktrees/<branch name>',
  },
  'addWorktree.creating': { ja: '作成中...', en: 'Creating…' },

  // ---- BlameModal ----
  'blame.binaryUnsupported': {
    ja: 'バイナリファイルの blame は表示できません',
    en: 'Cannot show blame for binary files.',
  },
  'blame.tooLarge': {
    ja: 'ファイルが大きすぎます(2MB を超えています)',
    en: 'File is too large (over 2MB).',
  },
  'blame.emptyFile': { ja: '空のファイルです', en: 'This file is empty.' },
  'blame.uncommittedFull': { ja: '未コミットの変更', en: 'Uncommitted change' },
  'blame.uncommittedShort': { ja: '未コミット', en: 'Uncommitted' },

  // ---- FileHistoryModal ----
  'fileHistory.title': { ja: 'ファイルの履歴 — {path}', en: 'File history — {path}' },
  'fileHistory.renameLabel': { ja: 'リネーム: {from} → {to}', en: 'Renamed: {from} → {to}' },
  'fileHistory.selectCommitHint': {
    ja: 'コミットを選択すると差分を表示します',
    en: 'Select a commit to view its diff.',
  },
} as const satisfies Record<string, Record<Lang, string>>;
