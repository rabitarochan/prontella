import type { Lang } from './langStore';

// ファイル / タイル / 検索 / ターミナル系の文字列。strings.ts でマージされる。

export const FILES_STRINGS = {
  // ---- ファイルタブ / エディター (FilesTab) ----
  'files.oversizeDraftWarning': {
    ja: '未保存の編集が大きすぎるため、切替・リロード後は保持されません',
    en: 'Unsaved edits that are too large will not be kept after switching or reloading',
  },
  'files.historyMenuItem': { ja: 'ファイルの履歴...', en: 'File history...' },
  'files.openPreview': { ja: 'プレビューを開く', en: 'Open preview' },
  'files.diskChangedWhileAwayWarning': {
    ja: '切替中にディスク上のファイルが変更されました。保存すると上書きします',
    en: 'The file on disk changed while this tab was inactive. Saving will overwrite it.',
  },
  'files.discardChangesTitle': { ja: '変更を破棄', en: 'Discard changes' },
  'files.discardChangesMessage': {
    ja: '{name} の変更を破棄して閉じますか?',
    en: 'Discard changes to {name} and close?',
  },
  'files.discardAndClose': { ja: '破棄して閉じる', en: 'Discard and close' },
  'files.savedMessage': { ja: '✓ 保存しました', en: '✓ Saved' },
  'files.reloadTitle': { ja: '再読み込み', en: 'Reload' },
  'files.reloadDiscardMessage': {
    ja: '{name} の未保存の変更を破棄して再読み込みしますか?',
    en: 'Discard unsaved changes to {name} and reload?',
  },
  'files.discardAndReload': { ja: '破棄して再読み込み', en: 'Discard and reload' },
  'files.explorerTooltip': { ja: 'エクスプローラー', en: 'Explorer' },
  'files.searchTooltip': { ja: '検索 (Ctrl+Shift+F)', en: 'Search (Ctrl+Shift+F)' },
  'files.selectFilePlaceholder': { ja: 'ファイルを選択してください', en: 'Select a file' },
  'files.previewTabTitle': { ja: 'プレビュー: {path}', en: 'Preview: {path}' },
  'files.binaryFileMessageWithSize': {
    ja: 'バイナリファイルは表示できません ({size} bytes)',
    en: 'Binary files cannot be displayed ({size} bytes)',
  },
  'files.tooLargeMessageWithSize': {
    ja: 'ファイルが大きすぎます ({size} KB)',
    en: 'File is too large ({size} KB)',
  },
  'files.saveHintCtrlS': { ja: 'Ctrl+S でも保存できます', en: 'You can also save with Ctrl+S' },
  'files.saving': { ja: '保存中...', en: 'Saving…' },
  'files.save': { ja: '保存', en: 'Save' },

  // ---- ファイルツリー (FileTree) ----
  'files.newFileNamePlaceholder': { ja: '新規ファイル名', en: 'New file name' },
  'files.newFolderNamePlaceholder': { ja: '新規フォルダー名', en: 'New folder name' },
  'files.newFileTooltip': { ja: '新規ファイル', en: 'New file' },
  'files.newFolderTooltip': { ja: '新規フォルダー', en: 'New folder' },

  // ---- エディターステータスバー (EditorStatusBar) ----
  'files.indentSpaces': { ja: 'スペース: {n}', en: 'Spaces: {n}' },
  'files.indentTabs': { ja: 'タブ: {n}', en: 'Tabs: {n}' },
  'files.positionIndicator': { ja: '行 {line}, 列 {column}', en: 'Ln {line}, Col {column}' },
  'files.changeIndentTooltip': { ja: 'インデントを変更', en: 'Change indentation' },
  'files.changeEncodingTooltip': { ja: 'エンコーディングを変更', en: 'Change encoding' },
  'files.reloadWithEncoding': { ja: 'エンコーディング指定で再読み込み', en: 'Reload with encoding' },
  'files.saveWithEncoding': { ja: 'エンコーディング指定で保存', en: 'Save with encoding' },
  'files.changeEolTooltip': { ja: '改行コードを変更', en: 'Change line ending' },

  // ---- クイックオープン (QuickOpenModal, Ctrl+P) ----
  'files.quickOpenTitle': { ja: 'ファイルを開く', en: 'Open file' },
  'files.quickOpenPlaceholder': { ja: 'ファイル名で検索', en: 'Search by file name' },
  'files.noFilesFound': { ja: 'ファイルが見つかりません', en: 'No files found' },
  'files.openFilesSection': { ja: '開いているファイル', en: 'Open files' },
  'files.filesSection': { ja: 'ファイル', en: 'Files' },

  // ---- Markdown プレビュー (MarkdownPreview) ----
  'files.refreshTooltip': { ja: '更新', en: 'Refresh' },
  'files.loadExternalImagesTooltip': { ja: '外部画像を読み込む', en: 'Load external images' },
  'files.binaryFileMessage': { ja: 'バイナリファイルは表示できません', en: 'Binary files cannot be displayed' },
  'files.tooLargeMessage': { ja: 'ファイルが大きすぎます', en: 'File is too large' },

  // ---- テキスト検索 (SearchPanel, Ctrl+Shift+F) ----
  'search.placeholder': { ja: '検索', en: 'Search' },
  'search.caseSensitiveTooltip': { ja: '大文字と小文字を区別', en: 'Match case' },
  'search.regexTooltip': { ja: '正規表現を使用', en: 'Use regular expression' },
  'search.summary': { ja: '{files} ファイル / {matches} 件', en: '{files} files / {matches} matches' },
  'search.limitHit': {
    ja: '(上限に達したため一部のみ表示)',
    en: '(Limit reached — showing partial results)',
  },
  'search.noResults': { ja: '結果がありません', en: 'No results' },

  // ---- ターミナル (TermPanel / XTermView) ----
  'term.closeTerminalTitle': { ja: 'ターミナルを終了', en: 'Close terminal' },
  'term.closeTerminalMessage': { ja: 'このターミナルを終了しますか?', en: 'Close this terminal?' },
  'term.closeConfirm': { ja: '終了する', en: 'Close' },
  'term.sessionEndedTitle': { ja: 'セッションは終了しました', en: 'Session has ended' },
  'term.endedLabel': { ja: '(終了)', en: '(ended)' },
  'term.closeTabTitle': { ja: 'タブを閉じる', en: 'Close tab' },
  'term.newShell': { ja: '新しいシェル', en: 'New shell' },
  'term.launchClaudeTitle': {
    ja: 'このWorktreeでClaude Codeを起動',
    en: 'Launch Claude Code in this worktree',
  },
  'term.connecting': { ja: '接続中…', en: 'Connecting…' },
  'term.empty': { ja: 'ターミナルがありません', en: 'No terminals' },
  'term.newShellButton': { ja: '＋ シェル', en: '+ Shell' },
  'term.launchClaudeButton': { ja: '✦ Claude 起動', en: '✦ Launch Claude' },
  'term.processExited': { ja: '[プロセスが終了しました]', en: '[Process exited]' },

  // ---- タイル (TilePane / TileGrid / useTileLayout) ----
  'tile.viewFiles': { ja: 'ファイル', en: 'Files' },
  'tile.viewGit': { ja: 'Git', en: 'Git' },
  'tile.viewTerm': { ja: 'ターミナル', en: 'Terminal' },
  'tile.closeTitle': { ja: 'タイルを閉じる', en: 'Close tile' },
  'tile.closeUnsavedMessage': {
    ja: '未保存の変更があります。タイルを閉じますか?',
    en: 'There are unsaved changes. Close the tile?',
  },
  'tile.switchViewTooltip': { ja: '表示を切り替え', en: 'Switch view' },
  'tile.dragHint': {
    ja: 'ドラッグでタイルを移動 (端 = 分割 / 中央 = 入れ替え)',
    en: 'Drag to move tile (edges = split, center = swap)',
  },
  'tile.splitRightTooltip': { ja: '右に分割', en: 'Split right' },
  'tile.splitDownTooltip': { ja: '下に分割', en: 'Split down' },
  'tile.empty': { ja: 'タイルがありません', en: 'No tiles' },
  'tile.resetLayout': { ja: 'レイアウト初期化', en: 'Reset layout' },
  'tile.closeSessionsConfirm': {
    ja: 'このタイルを閉じますか? (ターミナル {n} 件を終了します)',
    en: 'Close this tile? ({n} terminal session(s) will be closed.)',
  },

  // ---- デスクトップ通知 (agentEvents.ts → notify.ts) ----
  'notify.waitingTitle': { ja: '確認待ち — Claude Deck', en: 'Needs input — Claude Deck' },
  'notify.doneTitle': { ja: '完了 — Claude Deck', en: 'Done — Claude Deck' },
  'notify.waitingBody': {
    ja: '{label}: エージェントが応答を待っています',
    en: '{label}: The agent is waiting for a response',
  },
  'notify.doneBody': {
    ja: '{label}: エージェントが待機中になりました',
    en: '{label}: The agent is now idle',
  },
  'notify.archivedSessionLabel': { ja: '{name} (アーカイブ済み)', en: '{name} (Archived)' },
} as const satisfies Record<string, Record<Lang, string>>;
