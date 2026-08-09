import type { Lang } from './langStore';

// UI 文字列辞書。キーは <領域>.<意味> の camelCase。プレースホルダーは {name} 形式。
// サーバーが返すエラーメッセージは対象外 (将来課題)。

export const STRINGS = {
  // ---- 共通 ----
  'common.loading': { ja: '読み込み中...', en: 'Loading…' },
  'common.close': { ja: '閉じる', en: 'Close' },
  'common.cancel': { ja: 'キャンセル', en: 'Cancel' },
  'common.ok': { ja: 'OK', en: 'OK' },
  'common.add': { ja: '追加', en: 'Add' },
  'common.remove': { ja: '削除', en: 'Remove' },
  'common.clickToDismiss': { ja: 'クリックで閉じる', en: 'Click to dismiss' },
  'common.noGit': { ja: '(Git なし)', en: '(no Git)' },
  'common.detached': { ja: '(detached {head})', en: '(detached {head})' },

  // ---- 経過時間 ----
  'time.seconds': { ja: '{n}秒', en: '{n}s' },
  'time.minutes': { ja: '{n}分', en: '{n}m' },
  'time.hoursMinutes': { ja: '{h}時間{m}分', en: '{h}h {m}m' },

  // ---- エージェント状態 ----
  'status.busy': { ja: '実行中', en: 'Working' },
  'status.waiting': { ja: '確認待ち', en: 'Needs input' },
  'status.idle': { ja: '待機中', en: 'Idle' },
  'status.shell': { ja: 'シェル', en: 'Shell' },
  'status.none': { ja: '未起動', en: 'Not started' },
  'status.agentTooltip': { ja: 'エージェント: {status}', en: 'Agent: {status}' },

  // ---- アプリ / タブタイトル ----
  'app.titleWaiting': { ja: '({n}) 確認待ち — Claude Deck', en: '({n}) needs input — Claude Deck' },

  // ---- レール ----
  'rail.backToDeck': { ja: 'デッキへ戻る', en: 'Back to deck' },
  'rail.searchLabel': { ja: '検索・コマンド', en: 'Search & commands' },
  'rail.searchTooltip': { ja: 'ファイル検索 (Ctrl+P)', en: 'Find file (Ctrl+P)' },
  'rail.langTooltip': { ja: '表示言語', en: 'Display language' },

  // ---- サイドバー (リポジトリーナビ) ----
  'sidebar.repositories': { ja: 'リポジトリー', en: 'Repositories' },
  'sidebar.addRepo': { ja: 'リポジトリーを追加', en: 'Add repository' },
  'sidebar.addRepoMessage': {
    ja: '追加するディレクトリーのパスを入力してください。',
    en: 'Enter the path of the directory to add.',
  },
  'sidebar.empty': {
    ja: '＋ ボタンから\nリポジトリーを追加してください',
    en: 'Add a repository\nwith the + button',
  },
  'sidebar.pinned': { ja: 'ピン留め', en: 'Pinned' },
  'sidebar.archived': { ja: 'アーカイブ済み ({n})', en: 'Archived ({n})' },
  'sidebar.pin': { ja: 'ピン留め', en: 'Pin' },
  'sidebar.unpin': { ja: 'ピン留めを解除', en: 'Unpin' },
  'sidebar.archive': { ja: 'アーカイブ', en: 'Archive' },
  'sidebar.unarchive': { ja: 'アーカイブを解除', en: 'Unarchive' },
  'sidebar.moveUp': { ja: '上へ移動', en: 'Move up' },
  'sidebar.moveDown': { ja: '下へ移動', en: 'Move down' },
  'sidebar.removeFromDeck': { ja: 'Deck から削除', en: 'Remove from Deck' },
  'sidebar.removeRepoMessage': {
    ja: '{name} を Deck から削除しますか?\n(リポジトリー自体は削除されません)',
    en: 'Remove {name} from the Deck?\n(The repository itself is not deleted.)',
  },
  'sidebar.addWorktree': { ja: 'Worktree を追加', en: 'Add worktree' },
  'sidebar.removeWorktree': { ja: 'Worktree を削除', en: 'Remove worktree' },
  'sidebar.removeWorktreeMessage': {
    ja: 'Worktree を削除しますか?\n{path}\n\n※ ディレクトリーごと削除されます',
    en: 'Remove this worktree?\n{path}\n\nThe directory itself will be deleted.',
  },
  'sidebar.forceRemoveWorktree': { ja: 'Worktree を強制削除', en: 'Force-remove worktree' },
  'sidebar.forceRemoveWorktreeMessage': {
    ja: '削除に失敗しました:\n{message}\n\n未コミットの変更ごと強制削除しますか?',
    en: 'Removal failed:\n{message}\n\nForce-remove including uncommitted changes?',
  },
  'sidebar.forceRemove': { ja: '強制削除', en: 'Force remove' },
  'sidebar.archiveRepoTitle': { ja: 'リポジトリーをアーカイブ', en: 'Archive repository' },
  'sidebar.archiveBusyMessage': {
    ja: 'エージェントが動作中です。アーカイブすると状態表示が止まります(セッションは動き続けます)。続けますか?',
    en: 'An agent is running. Archiving stops status display (sessions keep running). Continue?',
  },
  'sidebar.mainMark': { ja: ' ●main', en: ' ●main' },

  // ---- デッキ (管制塔) ----
  'deck.emptyArchived': {
    ja: '表示できる worktree がありません(アーカイブ済み {n} 件)',
    en: 'No worktrees to show ({n} archived)',
  },
  'deck.emptyAdd': {
    ja: '左のサイドバーからリポジトリーを追加すると、Worktree とエージェントの状態が一覧表示されます。',
    en: 'Add a repository from the left rail to see all worktrees and agent status here.',
  },
  'deck.heroTitle': { ja: 'あなたの確認を待っています ({n})', en: 'Waiting for your input ({n})' },
  'deck.heroHint': { ja: 'クリックで確認へ →', en: 'Click to review →' },
  'deck.locateError': {
    ja: 'このセッションの worktree を特定できません: {cwd}',
    en: 'Cannot locate the worktree for this session: {cwd}',
  },
  'deck.gridTitle': {
    ja: '全 Worktree のエージェント状態',
    en: 'Agent status across all worktrees',
  },
  'deck.statAhead': { ja: 'ahead', en: 'ahead' },
  'deck.statBehind': { ja: 'behind', en: 'behind' },
  'deck.statStaged': { ja: 'ステージ済み', en: 'Staged' },
  'deck.statUnstaged': { ja: '未ステージ', en: 'Unstaged' },
  'deck.statUntracked': { ja: '未追跡', en: 'Untracked' },
  'deck.statConflicted': { ja: 'コンフリクト', en: 'Conflicts' },

  // ---- ワークツリービュー ----
  'wt.resetLayout': { ja: 'レイアウトを初期化', en: 'Reset layout' },
  'wt.resetLayoutMessage': {
    ja: 'レイアウトを初期化しますか?(未保存の編集内容は失われます)',
    en: 'Reset the layout? (Unsaved edits will be lost.)',
  },
  'wt.resetLayoutConfirm': { ja: '初期化', en: 'Reset' },

  // ---- テーマ ----
  'theme.light': { ja: 'ライト', en: 'Light' },
  'theme.dark': { ja: 'ダーク', en: 'Dark' },
  'theme.system': { ja: 'システム', en: 'System' },
  'theme.tooltip': { ja: 'テーマ切り替え', en: 'Switch theme' },

  // ---- 要対応ベル ----
  'bell.tooltipWaiting': { ja: '確認待ち {n} 件', en: '{n} waiting for input' },
  'bell.tooltip': { ja: '要対応キュー', en: 'Attention queue' },
  'bell.waitingSection': { ja: '確認待ち', en: 'Waiting for input' },
  'bell.waitingSectionCount': { ja: '確認待ち ({n})', en: 'Waiting for input ({n})' },
  'bell.empty': {
    ja: '対応が必要なエージェントはありません',
    en: 'No agents need your attention',
  },
  'bell.idleSection': { ja: '待機中のエージェント ({n})', en: 'Idle agents ({n})' },
  'bell.desktopNotifications': { ja: 'デスクトップ通知', en: 'Desktop notifications' },
  'bell.notificationsBlocked': {
    ja: 'ブラウザ設定で通知がブロックされています',
    en: 'Notifications are blocked in browser settings',
  },
  'bell.sound': { ja: 'サウンド', en: 'Sound' },
} as const satisfies Record<string, Record<Lang, string>>;

export type StringKey = keyof typeof STRINGS;
