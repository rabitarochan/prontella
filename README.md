# Claude Deck 3

複数の Git リポジトリー × 複数の Worktree 上で動く Claude Code エージェントを一元管理するデッキ。

Claude Code は **PTY (実ターミナル) 上で対話モードのまま起動**するため、サブスクリプション課金のまま利用できます (Agent SDK / API は使いません)。

## アーキテクチャ

- **サーバー** (`server/`): Node.js + Express + ws + node-pty
  - Git 操作は `git` CLI を `execFile` で実行 (porcelain 形式をパース)
  - ターミナルは node-pty で生成し WebSocket (`/ws/term?id=`) で中継
  - エージェントステータスは 2 系統で検知 (hooks が優先、ヒューリスティックはフォールバック)
    - **Claude Code hooks**: 「✦ Claude 起動」時に `claude --settings ~/.claude-deck3/hook-settings.json` を注入。
      各フックイベント (SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Notification / Stop / SessionEnd) を
      `~/.claude-deck3/deck-hook.mjs` が `POST /api/agent-events` へ転送する。TUI 文言に依存せず正確・即時
      (どのセッションかは PTY の環境変数 `CLAUDE_DECK_PORT` / `CLAUDE_DECK_TERM` で識別。
      ユーザー自身の hooks 設定とはマージされ共存する)
    - **TUI ヒューリスティック** (手動起動した claude 等のフォールバック): PTY 出力を ANSI 除去して監視
      - `esc to interrupt` / スピナーグリフ → **実行中 (busy)**
      - `❯ 1.` 等の許可プロンプト → **確認待ち (waiting)**
      - スピナーが 3 秒止まる → **待機中 (idle)**
  - 全セッションのステータス変化は WebSocket (`/ws/events`) でクライアントへ push
- **クライアント** (`client/`): Vite + React + xterm.js + Zustand
- 設定は `~/.claude-deck3/config.json` に保存 (登録リポジトリー一覧)
- Windows / macOS / Linux 対応 (シェルは PowerShell / `$SHELL` を自動選択)

## 機能

- リポジトリー登録とデッキ表示 (全 Worktree のブランチ・変更数・エージェント状態を一覧)
- Git Worktree の追加 (新規/既存ブランチ) と削除 — 既定パスは `../<repo>.worktrees/<branch>`
- Worktree ビューは VS Code 風のタイルレイアウト (分割・ドラッグリサイズ・worktree ごとに永続化)。
  **各タイルが 2 段階のタブを持つ**: タイルヘッダーで ファイル / Git / ターミナル を切り替え (切り替えても状態は保持)
  - **ファイル**: ファイルツリー (react-arborist + VS Code codicons) + 開いたファイルをタブで切り替える Monaco Editor (Ctrl+S 保存)
  - **Git**: 3 ペイン構成 — ワークスペース (サイドバー) と ステージ済み|変更 リストは常時表示、
    リストで選択したファイルの左右 diff だけがタブで開く
  - **ターミナル**: タイルが所有するターミナルをタブで切り替え (タブにエージェントのステータスドット表示)。
    別タイルに分割してターミナルを並べることも可能
- 「Git」タブ: Sourcetree 風レイアウト — 左サイドバー (ファイルステータス / 履歴 / ブランチ / リモート / スタッシュ) + メインビュー
- Monaco DiffEditor によるサイドバイサイド差分、ステージ/アンステージ (個別・一括)、変更の破棄、コミット (amend 対応)
- フェッチ / プル / プッシュ (upstream 未設定時は自動で `-u origin`)
- ブランチタブ: 一覧 (ローカル/リモート)・作成・切り替え・削除・マージ (コンフリクト時はマージ中止ボタン)
- スタッシュ (保存 / 適用 / pop / 削除、未追跡ファイル含む)
- Sourcetree 風コミットグラフ (全ブランチの DAG をレーン描画、ブランチ/タグのラベルチップ、`--all` トグル)
- コミット詳細 (変更ファイル一覧 + ファイルごとの差分。マージコミットは第一親との差分)
- Worktree ごとのターミナル (複数可) と「✦ Claude 起動」ボタン
- エージェントステータスのリアルタイム表示 (実行中 / 確認待ち / 待機中 / シェル / 未起動)
- 通知: エージェントが**確認待ち**になった瞬間 / **実行完了**した時にデスクトップ通知 + チャイム。
  タブタイトルにも確認待ち件数をバッジ表示 (他のタブで作業していても分かる)
- 要対応キュー: トップバーのベル 🔔 から確認待ち・待機中のエージェントを経過時間つきで一覧、
  クリックで該当 Worktree へジャンプ。通知とサウンドの ON/OFF もここで切り替え

## 使い方

### npx で実行 (配布版)

```sh
npx @rabitarochan/claude-deck            # 起動してブラウザを開く
npx @rabitarochan/claude-deck --port 4000 --no-open
```

- 要 Node.js 18+ と git。node-pty は Windows / macOS 向けプレビルドバイナリ同梱のためビルドツール不要 (Linux のみ gcc 等が必要)
- ブラウザを閉じてもサーバーが生きている限りターミナルセッションは維持されます

### リポジトリーから

```sh
npm install

# 開発 (サーバー :3711 + Vite :5173)
npm run dev          # http://localhost:5173

# 本番相当 (ビルドしてランチャーから起動)
npm run build
npm start            # = node bin/claude-deck.js
```

### npm への公開

```sh
npm login
npm publish          # prepublishOnly が自動でビルドします
```

サイドバーの「＋」からリポジトリーのパスを登録 → デッキにカードが並びます。
Worktree を開き「✦ Claude 起動」でそのディレクトリーをカレントに Claude Code が起動します。

## 補足

- サーバーは `127.0.0.1` のみで listen します (ファイル書き込み・PTY を持つため外部公開しないこと)
- `scripts/ws-debug.mjs` はターミナル出力とステータス検知のデバッグ用ヘルパー
- 「✦ Claude 起動」以外で起動した claude (ターミナルに手打ちなど) は hooks が入らないため、
  TUI 文言ヒューリスティックのみで検知します。文言変更で精度が落ちた場合は `server/pty.ts` の
  `BUSY_RE` / `PROMPT_RE` を調整してください。手動起動でも hooks 検知を効かせたい場合は
  `claude --settings ~/.claude-deck3/hook-settings.json` で起動すれば OK です
- デスクトップ通知は初回にベル 🔔 のドロップダウンから許可してください (ブラウザの通知許可が必要)
