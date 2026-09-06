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
  'files.diskChangedConflict': {
    ja: 'このファイルは外部で変更されました',
    en: 'This file was changed outside the editor',
  },
  'files.loadLatestDiscardingEdits': {
    ja: '破棄して最新を読み込む',
    en: 'Discard edits and load latest',
  },
  'files.keepEditing': { ja: '編集を継続', en: 'Keep editing' },
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
  'files.splitEditorTooltip': { ja: 'エディターを右に分割', en: 'Split editor right' },
  'files.saving': { ja: '保存中...', en: 'Saving…' },
  'files.save': { ja: '保存', en: 'Save' },

  // ---- ファイルツリー (FileTree) ----
  'files.newFileNamePlaceholder': { ja: '新規ファイル名', en: 'New file name' },
  'files.newFolderNamePlaceholder': { ja: '新規フォルダー名', en: 'New folder name' },
  'files.newFileTooltip': { ja: '新規ファイル', en: 'New file' },
  'files.newFolderTooltip': { ja: '新規フォルダー', en: 'New folder' },
  'files.createFileMenuItem': { ja: 'ファイルの作成', en: 'New file...' },
  'files.createFolderMenuItem': { ja: 'フォルダーの作成', en: 'New folder...' },
  'files.revealInExplorerMenuItem': { ja: 'Explorer で開く', en: 'Reveal in File Explorer' },
  'files.copyPathMenuItem': { ja: 'パスのコピー', en: 'Copy path' },
  'files.copyRelativePathMenuItem': { ja: '相対パスのコピー', en: 'Copy relative path' },
  'files.renameMenuItem': { ja: '名前の変更', en: 'Rename' },
  'files.duplicateFileMenuItem': { ja: 'ファイルのコピー', en: 'Duplicate file' },
  'files.duplicateFolderMenuItem': { ja: 'フォルダーのコピー', en: 'Duplicate folder' },
  'files.copiedMessage': { ja: '✓ コピーしました', en: '✓ Copied' },
  'files.deleteMenuItem': { ja: '削除', en: 'Delete' },
  'files.deleteConfirmTitle': { ja: '削除', en: 'Delete' },
  'files.deleteFileConfirmMessage': {
    ja: '{name} を削除しますか? (元に戻せません)',
    en: 'Delete {name}? This cannot be undone.',
  },
  'files.deleteFolderConfirmMessage': {
    ja: '{name} とその中身をすべて削除しますか? (元に戻せません)',
    en: 'Delete {name} and all of its contents? This cannot be undone.',
  },
  'files.deleteConfirmLabel': { ja: '削除する', en: 'Delete' },

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
  'term.reconnecting': { ja: '再接続中…', en: 'Reconnecting…' },
  'term.sessionLost': { ja: 'セッションは失われました', en: 'Session lost' },
  'term.splitTerminalTooltip': {
    ja: 'アクティブなターミナルを右隣へ分割',
    en: 'Split the active terminal to the right',
  },

  // ---- Claude 使用量 (ターミナルタイルのヘッダー) ----
  'usage.loading': { ja: '使用量を取得中…', en: 'Loading usage…' },
  'usage.fiveHour': { ja: '5h', en: '5h' },
  'usage.weekly': { ja: '週', en: 'Week' },
  'usage.refresh': { ja: '使用量を再取得', en: 'Refresh usage' },
  'usage.refreshHint': {
    ja: 'クリックで再取得',
    en: 'Click to refresh',
  },
  'usage.tooltipLine': { ja: '{label}: {pct}% 使用', en: '{label}: {pct}% used' },
  'usage.tooltipLineReset': {
    ja: '{label}: {pct}% 使用 (リセットまで {remaining})',
    en: '{label}: {pct}% used (resets in {remaining})',
  },
  'usage.tooltipUpdated': { ja: '最終取得: {time}', en: 'Updated: {time}' },

  // ---- エージェント (ChatPanel / ChatView — Agent SDK セッション) ----
  'chat.newSession': { ja: '新しいセッション', en: 'New session' },
  'chat.empty': { ja: 'エージェントセッションがありません', en: 'No agent sessions' },
  'chat.startHint': {
    ja: '指示を送信してエージェントを開始します',
    en: 'Send instructions to start the agent',
  },
  'chat.inputPlaceholder': {
    ja: '指示を入力… (Enter で送信 / Shift+Enter で改行 / Esc で停止)',
    en: 'Type instructions… (Enter to send / Shift+Enter for newline / Esc to stop)',
  },
  'chat.inputPlaceholderCtrl': {
    ja: '指示を入力… (Ctrl+Enter で送信 / Enter で改行 / Esc で停止)',
    en: 'Type instructions… (Ctrl+Enter to send / Enter for newline / Esc to stop)',
  },
  'chat.submitKeyTooltip': { ja: '送信キーの設定', en: 'Submit key settings' },
  'chat.submitKeyEnter': {
    ja: 'Enter で送信 / Shift+Enter で改行',
    en: 'Enter to send / Shift+Enter for newline',
  },
  'chat.submitKeyCtrlEnter': {
    ja: 'Ctrl+Enter で送信 / Enter で改行',
    en: 'Ctrl+Enter to send / Enter for newline',
  },
  'chat.send': { ja: '送信', en: 'Send' },
  'chat.interrupt': { ja: '停止', en: 'Stop' },
  'chat.working': { ja: '実行中…', en: 'Working…' },
  'chat.thinking': { ja: '思考', en: 'Thinking' },
  'chat.todoTitle': { ja: 'TODO', en: 'Todos' },
  'chat.toolRunning': { ja: '…', en: '…' },
  'chat.modeManual': { ja: '手動', en: 'Manual' },
  'chat.modeAcceptEdits': { ja: '編集を自動承認', en: 'Accept edits' },
  'chat.modePlan': { ja: 'プラン', en: 'Plan' },
  'chat.modeAuto': { ja: '自動', en: 'Auto' },
  'chat.modeTooltip': {
    ja: '許可モードを切り替え (入力欄で Shift+Tab)',
    en: 'Switch permission mode (Shift+Tab in input)',
  },
  'chat.modelTooltip': { ja: 'モデル / Effort / Thinking を切り替え', en: 'Switch model / effort / thinking' },
  'chat.modelMenuModels': { ja: 'モデル', en: 'Model' },
  'chat.modelMenuEffort': { ja: 'Effort', en: 'Effort' },
  'chat.modelMenuThinking': { ja: 'Thinking (拡張思考)', en: 'Thinking (extended)' },
  'chat.contextTooltip': {
    ja: 'コンテキスト使用量 (直近の API 呼び出しの実測値)',
    en: 'Context usage (measured from the latest API call)',
  },
  'chat.planTitle': { ja: 'プランの承認', en: 'Approve plan' },
  'chat.planApprove': { ja: '承認 (手動確認)', en: 'Approve (manual)' },
  'chat.planApproveAccept': {
    ja: '承認して編集を自動承認',
    en: 'Approve & auto-accept edits',
  },
  'chat.planApproveAuto': {
    ja: '承認して自動モード',
    en: 'Approve & auto mode',
  },
  'chat.planKeep': { ja: 'プランを続ける', en: 'Keep planning' },
  'chat.questionTitle': { ja: 'エージェントからの質問', en: 'Question from agent' },
  'chat.questionSubmit': { ja: '回答を送信', en: 'Submit answers' },
  'chat.questionSkip': { ja: '回答しない', en: 'Decline' },
  'chat.questionOtherPlaceholder': {
    ja: 'その他 (自由入力)',
    en: 'Other (free text)',
  },
  'chat.removeImage': { ja: '画像を削除', en: 'Remove image' },
  'chat.resumeListTitle': { ja: '保存されたセッション', en: 'Saved sessions' },
  'chat.resume': { ja: '再開する', en: 'Resume' },
  'chat.discardRecord': { ja: '破棄', en: 'Discard' },
  'chat.permissionTitle': { ja: 'ツール実行の許可: {tool}', en: 'Tool permission: {tool}' },
  'chat.allow': { ja: '許可', en: 'Allow' },
  'chat.alwaysAllow': { ja: '常に許可 (セッション)', en: 'Always allow (session)' },
  'chat.deny': { ja: '拒否', en: 'Deny' },
  'chat.permissionAllowed': { ja: '{tool} を許可しました', en: 'Allowed {tool}' },
  'chat.permissionDenied': { ja: '{tool} を拒否しました', en: 'Denied {tool}' },
  'chat.turnError': { ja: 'ターンがエラーで終了 ({subtype})', en: 'Turn ended with error ({subtype})' },
  'chat.ended': { ja: 'セッションは終了しました', en: 'Session has ended' },
  'chat.endedLabel': { ja: '(終了)', en: '(ended)' },
  'chat.sessionEndedTitle': { ja: 'セッションは終了しました', en: 'Session has ended' },
  'chat.closeChatTitle': { ja: 'セッションを終了', en: 'Close session' },
  'chat.closeChatMessage': { ja: 'このエージェントセッションを終了しますか?', en: 'Close this agent session?' },
  'chat.closeConfirm': { ja: '終了する', en: 'Close' },

  // ---- タイル (TilePane / TileGrid / useTileLayout) ----
  'tile.viewFiles': { ja: 'ファイル', en: 'Files' },
  'tile.viewGit': { ja: 'Git', en: 'Git' },
  'tile.viewTerm': { ja: 'ターミナル', en: 'Terminal' },
  'tile.viewChat': { ja: 'エージェント', en: 'Agent' },
  'tile.viewCode': { ja: 'VS Code', en: 'VS Code' },

  // ---- VS Code タイル (VsCodePanel) ----
  'vscode.starting': { ja: 'VS Code を起動しています…', en: 'Starting VS Code…' },
  'vscode.notReady': { ja: 'VS Code を起動できませんでした', en: 'Could not start VS Code' },
  'vscode.retry': { ja: '再試行', en: 'Retry' },
  'vscode.resolving': { ja: 'VSCodium のバージョンを確認しています…', en: 'Resolving VSCodium version…' },
  'vscode.downloading': { ja: 'VSCodium をダウンロードしています', en: 'Downloading VSCodium' },
  'vscode.downloadNote': {
    ja: '初回のみです。次回からはこの待ち時間はありません。',
    en: 'First run only — later launches skip this.',
  },
  'vscode.verifying': { ja: 'ダウンロードを検証しています…', en: 'Verifying download…' },
  'vscode.extracting': { ja: '展開しています…', en: 'Extracting…' },
  'vscode.settingsTitle': { ja: 'VS Code タイルの設定', en: 'VS Code tile settings' },
  'vscode.openSettings': { ja: 'VS Code タイルの設定', en: 'VS Code tile settings' },
  'vscode.remoteSettings': { ja: 'リモート設定 (Machine)', en: 'Remote settings (Machine)' },
  'vscode.remoteSettingsNote': {
    ja: 'ここで書けるのはリモート設定だけです。ユーザー設定とキーバインドはブラウザー側に保存されるため Prontella からは扱えません。リモート設定はユーザー設定より優先されますが、security.workspace.trust.enabled のような APPLICATION スコープの設定は無視されます。',
    en: 'Only remote settings can be written here. User settings and keybindings live in the browser and cannot be managed from Prontella. Remote settings override user settings, but APPLICATION-scoped ones (e.g. security.workspace.trust.enabled) are ignored.',
  },
  'vscode.saveSettings': { ja: '設定を保存', en: 'Save settings' },
  'vscode.settingsSaved': { ja: '保存しました。VS Code 側に自動で反映されます。', en: 'Saved. VS Code picks this up automatically.' },
  'vscode.extensions': { ja: '拡張機能', en: 'Extensions' },
  'vscode.extensionsNote': {
    ja: 'Open VSX から取得します。VS Code タイル内の拡張機能ビューからも追加できます。反映にはタイルの再読み込みが必要な場合があります。',
    en: 'Fetched from Open VSX. You can also install from the Extensions view inside the tile. A tile reload may be needed to activate.',
  },
  'vscode.extensionsServeWebNote': {
    ja: 'serve-web バックエンドでは Prontella から追加/削除できません (この CLI は --install-extension を持たないため)。VS Code タイル内の拡張機能ビューから操作してください。',
    en: 'The serve-web backend has no --install-extension CLI, so extensions cannot be managed from Prontella. Use the Extensions view inside the tile.',
  },
  'vscode.install': { ja: '追加', en: 'Install' },
  'vscode.installing': { ja: '追加中…', en: 'Installing…' },
  'vscode.uninstall': { ja: '削除', en: 'Uninstall' },
  'vscode.uninstallTitle': { ja: '拡張機能を削除', en: 'Uninstall extension' },
  'vscode.uninstallMessage': { ja: '{id} を削除しますか?', en: 'Uninstall {id}?' },
  'vscode.extensionChanged': { ja: '変更しました。反映にはタイルの再読み込みが必要な場合があります。', en: 'Done. A tile reload may be needed to activate.' },
  'vscode.noExtensions': { ja: 'まだ拡張機能はありません。', en: 'No extensions yet.' },
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
  'notify.waitingTitle': { ja: '確認待ち — Prontella', en: 'Needs input — Prontella' },
  'notify.doneTitle': { ja: '完了 — Prontella', en: 'Done — Prontella' },
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
