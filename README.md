# Claude Deck 3

複数の Git リポジトリー × 複数の Worktree 上で動く Claude Code エージェントを一元管理するデッキ。

Claude Code は **PTY (実ターミナル) 上で対話モードのまま起動**するため、サブスクリプション課金のまま利用できます (Agent SDK / API は使いません)。

## アーキテクチャ

- **サーバー** (`server/`): Node.js + Express + ws + node-pty
  - Git 操作は `git` CLI を `execFile` で実行 (porcelain 形式をパース)
  - ターミナルは node-pty で生成し WebSocket (`/ws/term?id=`) で中継
  - エージェントステータスは PTY 出力を ANSI 除去して監視
    - `esc to interrupt` → **実行中 (busy)**
    - `Do you want ...` 等の許可プロンプト → **確認待ち (waiting)**
    - スピナーが 3 秒止まる → **待機中 (idle)**
- **クライアント** (`client/`): Vite + React + xterm.js + Zustand
- 設定は `~/.claude-deck3/config.json` に保存 (登録リポジトリー一覧)
- Windows / macOS / Linux 対応 (シェルは PowerShell / `$SHELL` を自動選択)

## 機能

- リポジトリー登録とデッキ表示 (全 Worktree のブランチ・変更数・エージェント状態を一覧)
- Git Worktree の追加 (新規/既存ブランチ) と削除 — 既定パスは `../<repo>.worktrees/<branch>`
- ファイルツリー (react-arborist + VS Code codicons) + Monaco Editor によるファイル閲覧・編集 (Ctrl+S 保存)
- 変更一覧 + Monaco DiffEditor によるサイドバイサイド差分、ステージ/アンステージ (個別・一括)、変更の破棄、コミット (amend 対応)
- フェッチ / プル / プッシュ (upstream 未設定時は自動で `-u origin`)
- ブランチタブ: 一覧 (ローカル/リモート)・作成・切り替え・削除・マージ (コンフリクト時はマージ中止ボタン)
- スタッシュ (保存 / 適用 / pop / 削除、未追跡ファイル含む)
- コミット履歴 + コミット詳細 (変更ファイル一覧 + ファイルごとの差分)
- Worktree ごとのターミナル (複数可) と「✦ Claude 起動」ボタン
- エージェントステータスのリアルタイム表示 (実行中 / 確認待ち / 待機中 / シェル / 未起動)

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
- ステータス検知は Claude Code の TUI 文言に依存するヒューリスティックです。文言変更で精度が落ちた場合は `server/pty.ts` の `BUSY_RE` / `PROMPT_RE` を調整してください
