import type { Lang } from './langStore';
import { FILES_STRINGS } from './strings-files';
import { GIT_STRINGS } from './strings-git';

// UI 文字列辞書。キーは <領域>.<意味> の camelCase。プレースホルダーは {name} 形式。
// サーバーが返すエラーメッセージは対象外 (将来課題)。
// 量が多い領域は strings-files.ts (ファイル/タイル/検索系) と
// strings-git.ts (Git 系) に分割し、ここでマージする。

const CORE_STRINGS = {
  // ---- 共通 ----
  'common.loading': { ja: '読み込み中...', en: 'Loading…' },
  'common.close': { ja: '閉じる', en: 'Close' },
  'common.cancel': { ja: 'キャンセル', en: 'Cancel' },
  'common.ok': { ja: 'OK', en: 'OK' },
  'common.add': { ja: '追加', en: 'Add' },
  'common.remove': { ja: '削除', en: 'Remove' },
  'common.clickToDismiss': { ja: 'クリックで閉じる', en: 'Click to dismiss' },
  'common.run': { ja: '実行', en: 'Run' },
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

  // ---- モバイル (/m) ----
  'mobile.title': { ja: 'Claude Deck', en: 'Claude Deck' },
  'mobile.back': { ja: '一覧', en: 'List' },
  'mobile.refresh': { ja: '更新', en: 'Refresh' },
  'mobile.activeTitle': { ja: '稼働中のエージェント', en: 'Active agents' },
  'mobile.savedTitle': { ja: '保存されたセッション', en: 'Saved sessions' },
  'mobile.noSessions': {
    ja: 'エージェントセッションがありません (PC で開始してください)',
    en: 'No agent sessions (start one on your PC)',
  },

  // ---- レール ----
  'rail.backToDeck': { ja: 'デッキへ戻る', en: 'Back to deck' },
  'rail.searchLabel': { ja: '検索・コマンド', en: 'Search & commands' },
  'rail.searchTooltip': { ja: 'コマンドパレット (Ctrl+K)', en: 'Command palette (Ctrl+K)' },
  'rail.langTooltip': { ja: '表示言語', en: 'Display language' },

  // ---- コマンドパレット (Ctrl+K) ----
  'palette.title': { ja: 'コマンドパレット', en: 'Command palette' },
  'palette.placeholder': {
    ja: '移動先・コマンドを検索',
    en: 'Search destinations & commands',
  },
  'palette.sectionWorktrees': { ja: 'ワークツリー', en: 'Worktrees' },
  'palette.sectionCommands': { ja: 'コマンド', en: 'Commands' },
  'palette.launchClaude': {
    ja: 'Claude 起動(フォーカス中のタイル)',
    en: 'Launch Claude (focused tile)',
  },
  'palette.addWorktree': { ja: 'Worktree を追加… — {repo}', en: 'Add worktree… — {repo}' },
  'palette.quickOpen': { ja: 'ファイル検索 (Ctrl+P)', en: 'Find file (Ctrl+P)' },
  'palette.theme': { ja: 'テーマ: {mode}', en: 'Theme: {mode}' },
  'palette.langJa': { ja: '表示言語: 日本語', en: 'Language: 日本語' },
  'palette.langEn': { ja: '表示言語: English', en: 'Language: English' },

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

  // ---- VNC (右ペイン) ----
  'vnc.title': { ja: 'リモートデスクトップ', en: 'Remote desktop' },
  'vnc.railTooltip': { ja: 'リモートデスクトップ (VNC)', en: 'Remote desktop (VNC)' },
  'vnc.paletteToggle': { ja: 'リモートデスクトップ (VNC) を開閉', en: 'Toggle remote desktop (VNC)' },
  'vnc.connect': { ja: '接続', en: 'Connect' },
  'vnc.disconnect': { ja: '切断', en: 'Disconnect' },
  'vnc.reconnect': { ja: '再接続', en: 'Reconnect' },
  'vnc.connecting': { ja: '接続中…', en: 'Connecting…' },
  'vnc.checking': { ja: 'VNC サーバーを確認中…', en: 'Checking VNC server…' },
  'vnc.idleHint': {
    ja: '{host}:{port} の VNC サーバーへ接続します',
    en: 'Connect to the VNC server at {host}:{port}',
  },
  'vnc.viewOnly': { ja: '表示のみ', en: 'View only' },
  'vnc.ctrlAltDel': { ja: 'Ctrl+Alt+Del を送信', en: 'Send Ctrl+Alt+Del' },
  'vnc.passwordTitle': { ja: 'VNC パスワード', en: 'VNC password' },
  'vnc.passwordPlaceholder': { ja: 'パスワードを入力', en: 'Enter password' },
  'vnc.passwordSubmit': { ja: '認証', en: 'Authenticate' },
  'vnc.authFailed': {
    ja: '認証に失敗しました: {reason}',
    en: 'Authentication failed: {reason}',
  },
  'vnc.disconnected': { ja: '切断されました', en: 'Disconnected' },
  'vnc.connectFailed': {
    ja: '接続に失敗しました (VNC サーバーには到達できますが、ハンドシェイクが完了しませんでした)',
    en: 'Connection failed (the VNC server is reachable but the handshake did not complete)',
  },
  'vnc.unreachableTitle': {
    ja: 'VNC サーバーに接続できません',
    en: 'Cannot reach the VNC server',
  },
  'vnc.unreachableBody': {
    ja: '{host}:{port} で待ち受けている VNC サーバーが見つかりません。この端末で VNC サーバーを起動してください。',
    en: 'No VNC server is listening at {host}:{port}. Start a VNC server on this machine.',
  },
  'vnc.setupGuideTitle': { ja: 'セットアップ', en: 'Setup' },
  'vnc.setupWindows': {
    ja: 'Windows: TightVNC / UltraVNC をサービスとしてインストールし、パスワードを設定',
    en: 'Windows: install TightVNC / UltraVNC as a service and set a password',
  },
  'vnc.setupMac': {
    ja: 'macOS: システム設定 → 共有 → 画面共有をオンにし、VNC パスワードを設定',
    en: 'macOS: System Settings → Sharing → enable Screen Sharing and set a VNC password',
  },
  'vnc.setupLinux': {
    ja: 'Linux: x11vnc (X11) / wayvnc (Wayland) / gnome-remote-desktop などを起動',
    en: 'Linux: run x11vnc (X11) / wayvnc (Wayland) / gnome-remote-desktop, etc.',
  },
  'vnc.configHint': {
    ja: '接続先は ~/.claude-deck3/config.json の "vnc" キー (例: {"vnc": {"host": "127.0.0.1", "port": 5900}}) か、環境変数 CLAUDE_DECK_VNC_HOST / CLAUDE_DECK_VNC_PORT で変更できます。',
    en: 'The target can be changed via the "vnc" key in ~/.claude-deck3/config.json (e.g. {"vnc": {"host": "127.0.0.1", "port": 5900}}) or the CLAUDE_DECK_VNC_HOST / CLAUDE_DECK_VNC_PORT environment variables.',
  },
  'vnc.retryProbe': { ja: '再確認', en: 'Check again' },
} as const satisfies Record<string, Record<Lang, string>>;

export const STRINGS = {
  ...CORE_STRINGS,
  ...FILES_STRINGS,
  ...GIT_STRINGS,
} as const;

export type StringKey = keyof typeof STRINGS;
