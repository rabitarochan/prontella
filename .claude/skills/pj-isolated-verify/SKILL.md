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
5. **ブラウザー検証は Node 組込み `WebSocket` による CDP 直叩きが第一候補**(検証を担当した
   verifier 3 体全員がブラウザー MCP を持たず、全員が独自に自作した実績あり。chrome-devtools MCP
   が使える環境ならそちらでもよいが、それは代替であってこの手順の前提ではない):
   - Chrome を `--remote-debugging-port=<ポート> --user-data-dir=<隔離プロファイル>` 付きで起動し、
     `WebSocket` で CDP エンドポイントに直接つなぐ
   - `Runtime.evaluate` で操作する。React の実イベント経路(`onChange`/`onClick`/`onContextMenu`)を
     発火させる必要がある(**罠 3** の Monaco 入力と同種の注意。単純な DOM プロパティ書き換えでは
     React が検知しない)
   - アプリ内ダイアログは React 製(ConfirmDialog)なので native dialog 処理は不要。native の
     `prompt`/`confirm` が残る箇所(Sidebar の worktree 削除等)は `Page.handleJavaScriptDialog` で
     先に応答を仕込む
   - `Runtime.consoleAPICalled` を購読し、検証開始時点をベースラインにして**新規コンソールエラー**
     のみを監視する
   - エビデンスは `Page.captureScreenshot`。ただし **OS 描画のツールチップ(`title` 属性の吹き出し)
     は写らない**ので、そこは属性値の確認で代替する
   - **要素が実際に描画されているかは `getBoundingClientRect()` で測る**。`getComputedStyle` が
     正しい値を返していても、親の交差軸整列などで要素の高さが 0 に収縮していれば画面には何も
     出ていない(このミッションで実際に踏んだ)
   - **配信されているアセットが今回の変更を含むかを、ビルド成果物への新規文字列の grep で確認する**
     (古いバンドルを検証してしまう事故を防ぐ)
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
5. **スクラッチは短パスに置く**: 深いスクラッチパス(~180 字)だと Windows の MAX_PATH で
   `git rebase` が `Filename too long` で失敗し `rebase-merge` が中途半端に残る。フィクスチャは
   短パス(例 `C:\vt5`)に作る(5.V で実測・切り分け済み。同一フィクスチャを短パスに置くだけで成功)
6. **サンドボックスや一時ファイルもスクラッチに置く**: 変異テスト用のコピー等をプロジェクト直下
   (例 `server/__mut__/`)に作ると、並行稼働中の別エージェントが「見覚えのないファイル」として
   検出し報告・照会のコストが発生する(実測。当該エージェントは自ら後始末し実コードも無改変
   だったが、検出・照会のコストは無駄だった)。サンドボックス・一時コピーも隔離スクラッチ配下に作る
7. **並行エージェントとの衝突回避**: 検証とレビューが同時に走ることがある。**ポート・スクラッチの
   パスは毎回別の値にする**。Chrome を kill するときは **`--user-data-dir` で自分のプロセスだけを
   特定する**(`tasklist` 等で確認し、他エージェントの Chrome には触れない)。`node_modules` に
   ジャンクションを張った場合は **`rmdir` で link のみ除去する**(`rm -rf` は実体を辿って本物を
   消す危険があるため使わない)

## 代替パターン(状況で使い分け)

- **本体アプリが重い/不要なとき**: 対象コンポーネントだけを単独マウントする使い捨て Vite ページ
  (client/*.html + entry.tsx)を立て、evaluate_script で DOM を直接アサートする方が速い
- **PTY・クリップボード系**: 別ポートにテストサーバーを立て、ページ内から side-WebSocket で
  PTY 入力を注入 + `navigator.clipboard` / `WebSocket.send` をモンキーパッチして観測する
  (キーボードシミュレーション不要で E2E 検証できる)
