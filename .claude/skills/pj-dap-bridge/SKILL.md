---
name: pj-dap-bridge
description: >
  prontella のデバッガーブリッジ (server/debug/* + client/src/debug/* + DebugTab) にアダプターを足す・
  直す・検証するときの定石。vscode-js-debug 固有の実測挙動 (TCP・startDebugging の子セッション・
  `type:"node"` が無応答・source.name の絶対パス・アダプターが自分で終わらない)、自動ダウンロードの罠
  (tarball に package.json が無い・GNU tar が `C:` をリモート扱い)、env の罠 (terminalEnv に node が無い)、
  ワイヤーとパス書き換えの不変条件、隔離検証の手順と環境起因の偽陰性まで。
  DAP / デバッガー / debugger / debug adapter / vscode-js-debug / dapDebugServer / netcoredbg /
  ブレークポイント / breakpoint / launch.json / /ws/debug / DebugTab に触る実装・調査タスクを
  委任するとき、brief の References にこのファイルのパスを入れる。
---

# pj-dap-bridge — デバッグアダプターを足す・直す・検証する定石 (prontella)

## 収録基準

DAP ブリッジ固有で、**コードを読んでも分からない**こと (アダプターの実測挙動、環境の差、検証で踏んだ罠) だけ。
設計は `docs/debug-mvp-plan.md`、測定値と判断は `scripts/dap-spike/RESULTS.md` が正。`pj-lsp-bridge` の兄弟。

## 0. 構造 (どこを触るか)

- ワイヤーは**素の DAP + `sessionId`** (`/ws/debug?root=`)。サーバー状態は合成イベント `prontella/status` / `prontella/session`
- `server/debug/registry.ts` アダプター表・config 検証 (`debug.<id>.dapDebugServer`)・解決順・自動ダウンロード /
  `host.ts` プロセス 1 本 (TCP、port 0) と接続 / `session.ts` 1 WS = 1 実行、接続の集合、launch 引数の注入、
  パス書き換え、逆要求、後始末 / `launchConfig.ts` JSONC・変数置換・内蔵既定 (純関数)
- クライアント `client/src/debug/`: `session.ts` (`DebugRun`、再接続しない) / `store.ts` (ハンドシェイク・reducer・BP 永続化) /
  `glyphs.ts` (装飾の純関数) / `decorations.ts` (モデルに張る)。UI は `components/DebugTab.tsx` (ロジック禁止)
- **1 実行 = 1 WS = アダプタープロセス 1 本**。LSP と違い共有・アイドル管理・サーキットブレーカーは無い

## 1. アダプターを足す手順

1. **スパイクを先に書く** (`scripts/dap-spike/d1.mjs` を複製)。測るのは listen までの時間・`initialized` の順序・
   逆要求の種類 (`startDebugging` / `runInTerminal`)・`stopped` がどの接続に来るか・BP の `verified` の形・
   `source.path` の形 (ドライブ文字の大小)・disconnect / kill 後に debuggee が消えるか・RSS・output の category
2. `registry.ts`: `ADAPTER_IDS` と `resolveAdapter` に足す。解決順は config 明示 > `~/.prontella/tools` > VS Code 拡張 > ダウンロード
3. `launchConfig.ts`: 対象 `type` と内蔵既定。**VS Code が拡張側で埋める値 (`type` の読み替え、`cwd` の `${workspaceFolder}`)
   はサーバーが埋める** — 素の DAP サーバーは何も補わない
4. `session.ts`: 逆要求の応答と `DROP_EVENTS`。クライアント側は `INITIALIZE_ARGS` の `adapterID`
5. 単体 (`session.test.ts` の FakeAdapter) → 隔離 E2E (§5)

## 2. vscode-js-debug の罠 (すべて実測、RESULTS.md)

- **`node dapDebugServer.js 0 127.0.0.1` は TCP サーバー**。port 0 が使え、stdout に `Debug server listening at 127.0.0.1:<port>` を
  1 行出す。1 TCP 接続 = 1 DAP セッション
- **root 接続はランチャー**。実ターゲットは `startDebugging` 逆要求 (`configuration.__pendingTargetId`) → 別 TCP 接続で動き、
  `thread` / `stopped` / `output` / `terminated` は**子接続に来る**。**子に setBreakpoints を送らないと止まらない**。
  被デバッグが spawn した孫でも `startDebugging` が来る (**子接続に対して**)。逆要求はどの接続にも来る前提で処理する
- **`type:"node"` を知らない — launch に永久に応答しない** (30 s TIMEOUT、エラーも来ない)。VS Code は拡張で `pwa-node` に
  読み替えている。`cwd` 既定 `${workspaceFolder}` も VS Code が埋めるもの。サーバーが両方補う
- `initialized` イベントは initialize 応答の直後ではなく**次の要求の応答の後**に来る。待たずに setBreakpoints → configurationDone → launch と送ってよい
- `setBreakpoints` の応答は launch 前は `verified:false, message:'breakpoint.provisionalBreakpoint'`、停止直後に `breakpoint{changed, verified:true}`。
  **応答の id は重複し、位置も動く** (import 行と本文行がともに `line:6`) → 要求順で対応付け、表示は要求行、id は当てにしない
- `source.path` は**小文字ドライブ** (`c:\Users\...`)、`source.name` にも同じ絶対パスが入る。root 外は `<node_internals>/...`
  が path にも入り `sourceReference` 非 0。起動コマンド行 (`<node.exe 絶対パス> .\src\main.js`) を `console` category の output で流す
- `console:'internalConsole'` なら `runInTerminal` は来ない。`integratedTerminal` だと来て、`env.NODE_OPTIONS` に bootloader を
  要求する — **env を渡せる PTY が無いと成立しない** (後回しの根拠)
- **アダプタープロセスは 1 実行が終わっても自分では終わらない**。クライアントが root の `terminated` で WS を閉じ、サーバーが
  `disconnect{terminateDebuggee}` → 1 s で kill。閉じ忘れると次の「開始」が `runs.has(root)` で黙って空振りする。
  root への disconnect は**応答が返らない** (子は 500 ms で `terminated`)。kill 単独でも debuggee は 0.4 s で消える
- `loadedSource` は 1 実行で 100 件超、`output` の `telemetry` は 3〜5 件 → サーバーで捨てる

## 3. 入手と env の罠

- **tarball (`js-debug-dap-v<ver>.tar.gz`) に `package.json` が無い**。`dapDebugServer.js` は CJS なので、上位に `"type":"module"` の
  package.json があると ESM 扱いで `Dynamic require of "fs" is not supported` で即死。展開後に `js-debug/package.json` へ
  `{"type":"commonjs"}` を書く
- **PATH の `tar` が GNU tar (Git for Windows `usr/bin`) だと `C:\...` を「ホスト C のリモート」と解釈する**
  (`Cannot connect to C: resolve failed`)。cwd を揃えて**相対パス**で渡す (bsdtar / GNU tar どちらでも通る)
- **`terminalEnv()` の PATH に node が無い** (mise / Volta はシェル profile でだけ入れる)。js-debug は `runtimeExecutable` 既定 `node`
  を PATH から引くので、prontella 自身の node のディレクトリーを **PATH の末尾**に足す (`withNodeFallback`)。先頭に足すと
  ユーザーの node より勝ってしまう (`pj-child-env` の決定則)
- ダウンロードは single-flight、完成形 (`<ver>/`) は最後の rename でだけ現れる。残骸は `.part` / `.tmp` / `.tar.gz`

## 4. 不変条件 (壊すと「見た目に何も起きない」)

- **クライアントは launch/attach の本体を送らない** (root は `{name}`|`{file}`、子は空)。本体はサーバーが組む / 注入する。
  クライアント由来のパスは `setBreakpoints.source.path` と `{file}` だけで、必ず `safeResolve`
- アダプター→クライアントの `source.path` は root 相対 (root 外は path を消し name だけ)、絶対パスの `name` は basename、
  output はホームと node のディレクトリーを潰す。**E2E は「ワイヤーに `C:\Users` が出ない」で判定する**
- 装飾は Monaco の**モデル**に張る (editor に張るとグループ分割で重なる)。root は model URI の leafId → `getLspWorkspace(leafId).root`
- BP の表示行はユーザーの要求行で固定。実行していないときは塗る、実行中に未検証なら hollow
- `DebugRun` は再接続しない: `reconnecting` / `gone` はどちらも終了。pending は全部 `success:false` で解決 (宙吊り禁止)

## 5. 検証 (`pj-isolated-verify` に加えて)

- 隔離 home には **`AppData\Local\Temp` を作る**: js-debug が `os.tmpdir()` に `mkdtempSync` して無いと即死する (製品の不具合ではない)
- **配信バンドルに今回の変更が入っているかを最初に確認する** (`client/dist` の grep)。古いバンドルで「終了後に再開始できない」を
  製品バグと誤認しかけた (修正後にビルドしていなかった)
- `/ws/debug` の直叩き (`ws` で root ハンドシェイク → `startDebugging` → 子ハンドシェイク) で 30 項目前後を機械判定し、
  UI は headless Chrome + CDP (ガタークリックは `.line-numbers` の左 = glyph margin の座標)。ブラウザー拡張は前提にしない
- 必ず通す: BP → 停止 (子接続) / ステップ 3 種 / 別ファイルのフレームクリックで `openAtLine` が新タブに着地 / REPL /
  続行 → 終了 → **再開始** / 停止ボタン → debuggee が消える / リロード後の BP 復元 / 敵対的入力 (`../x.js`、未知 name、
  `${env:X}`、request 不一致、未許可コマンド) が `success:false` で未転送 / 未登録 root は refused + 4003
- 後始末: 4711 の server と `--user-data-dir` で特定した Chrome を kill、`dapDebugServer` / debuggee の node.exe が無い、
  実 `~/.prontella` のタイムスタンプ不変、`tools/` が実 home に無い
