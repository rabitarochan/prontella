---
name: pj-isolated-verify
description: claude-deck3 の動作検証を、ユーザーの実設定・実リポジトリー・稼働中インスタンスに一切触れずに行う隔離環境手順(サーバー単体起動+実ブラウザー)。verifier / builder のスモーク・E2E 検証タスクを委任するとき、brief の References にこのファイルのパスを入れる。
---

# pj-isolated-verify — 隔離検証環境(claude-deck3)

## 原理

- 設定パスは `server/config.ts` の `os.homedir()/.claude-deck3/config.json`。Windows の
  `os.homedir()` は環境変数 `USERPROFILE` に従うため、**これを差し替えるだけで設定が完全隔離**される
- ユーザーは本物の claude-deck3 を常用中(vite 8110 / server 3711)。**ポートは必ず別にする**
  (慣例: 4711 または 3799)。vite dev の proxy は 3711 固定なので、隔離検証では vite dev を使わず
  ビルド済み client を server 単体で配信する

## 手順

1. スクラッチ配下に隔離ホームと一時 git リポジトリーを作成。
   **`git config core.autocrlf false` をリポジトリーローカルに設定**(罠 1)
2. client 側を触った変更なら **`npm run build` を先に完走させる**
   (server は client/dist が無いと起動に失敗する。ビルドと起動の競合に注意)
3. `USERPROFILE=<隔離ホーム> PORT=4711` で server を単体起動:
   `node_modules/.bin/tsx.cmd server/index.ts`(バックグラウンド)。
   **Volta シムが `Could not determine LocalAppData directory` で死ぬ場合**(罠 2)は
   Volta 実体 node.exe で `node_modules/tsx/dist/cli.mjs` を直叩き
4. リポジトリー登録は UI から、または API(`server/index.ts` の repos 系ルートを参照)
5. ブラウザー検証は chrome-devtools MCP(ToolSearch で一括ロード)。
   localStorage・内部状態の観測は evaluate_script。アプリ内ダイアログは React 製(ConfirmDialog)
   なので native dialog 処理は不要。native confirm が残る箇所(Sidebar の worktree 削除等)は
   handle_dialog を先に仕込む
6. **終了時の後始末(必須)**: サーバープロセス kill → ポート解放を確認 / ブラウザーページをクローズ /
   実設定 `%USERPROFILE%\.claude-deck3` のタイムスタンプが不変であることを確認して報告

## 罠(すべて実測済み)

1. **autocrlf**: 隔離ホームでは実 `~/.gitconfig`(autocrlf=false)が隠れ、システム既定の
   autocrlf=true に落ちる。CRLF 混入の赤ニシンで時間を溶かすので、一時リポジトリーに明示設定する
2. **Volta**: USERPROFILE 差し替えでシムが LocalAppData を見失う。実体 node.exe 直叩きで回避
3. **Monaco への入力**: 隠し textarea が aria-hidden のため、CDP の実キー入力(type_text 等)は
   Chrome の a11y ガードにブロックされる。**React Fiber から editor インスタンスを取得して
   `executeEdits()` を呼ぶ**と、onChange → dirty → debounce の実経路ごと検証できる
   (Ctrl+S / Ctrl+P などコマンド系ショートカットは別経路のため press_key で通常どおり動く)
4. **選択中 worktree の削除**は 4 秒ポーリングのファイルロックで `git worktree remove` が失敗する
   (既知の既存問題)。削除系の検証は別 worktree へ切替えてから行う

## 代替パターン(状況で使い分け)

- **本体アプリが重い/不要なとき**: 対象コンポーネントだけを単独マウントする使い捨て Vite ページ
  (client/*.html + entry.tsx)を立て、evaluate_script で DOM を直接アサートする方が速い
- **PTY・クリップボード系**: 別ポートにテストサーバーを立て、ページ内から side-WebSocket で
  PTY 入力を注入 + `navigator.clipboard` / `WebSocket.send` をモンキーパッチして観測する
  (キーボードシミュレーション不要で E2E 検証できる)
