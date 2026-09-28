# DAP スパイク測定結果 (2026-09-29、Windows 11 / Node 24.21.0 (mise) / vscode-js-debug 1.140.0)

閾値は計画 (Phase 0 の表) のとおり。測定後に動かしていない。
再現: `SPIKE_DAP=<abs>/js-debug/src/dapDebugServer.js node scripts/dap-spike/d1.mjs` (オプションは d1.mjs 冒頭)。

## 前提の変更: tarball に `package.json` が無い

`js-debug-dap-v1.140.0.tar.gz` の `js-debug/` には `package.json` が**無い**。`dapDebugServer.js` は CJS バンドルなので、
`"type":"module"` の package.json の配下 (この repo の `vt/` など) に置くと ESM として読まれ
`Error: Dynamic require of "fs" is not supported` で即死する。**展開後に `js-debug/package.json` へ `{"type":"commonjs"}` を書く**
(registry のダウンロード処理に含める。`~/.prontella/tools/` でも上位に ESM な package.json が無い保証は無い)。

## D1〜D10

| # | 結果 | 判定 |
|---|---|---|
| D1 | `node dapDebugServer.js 0 127.0.0.1` で **port 0 が使える**。stdout に `Debug server listening at 127.0.0.1:63670\n` (この 1 行だけ)。spawn → listening **114〜194 ms** | ✓ ≤ 3 s |
| D2 | initialize 3 ms。capabilities: `supportsConfigurationDoneRequest, supportsConditionalBreakpoints, supportsHitConditionalBreakpoints, supportsEvaluateForHovers, supportsSetVariable, supportsRestartRequest…`、`exceptionBreakpointFilters: [all, uncaught]`。**`initialized` イベントは initialize 応答の直後ではなく、次の要求 (setBreakpoints) の応答の後**に来る。configurationDone 前の launch は未検証 (順序どおり送れば済む)。launch 応答 119〜128 ms (root は「ランチャー」で、停止はここには来ない) | 事実 |
| D3 | **`startDebugging` は来る**: root 接続に `{request:'launch', configuration:{type:'pwa-node', name:'app.js [pid]', __pendingTargetId}}` (launch 応答の ≈100 ms 後)。子は**同じ port へ新規 TCP 接続 → initialize → setBreakpoints → configurationDone → launch(configuration をそのまま)** で動き、`thread`/`stopped`/`output(stdout/stderr)`/`terminated` は**すべて子接続**に来る。**子に setBreakpoints を送らないと止まらない** (run2: root だけに BP → 15 s 停止なし)。`autoAttachChildProcesses` 既定 true のため、被デバッグが spawn した孫プロセスでも**子接続に対して** `startDebugging` が来る (1 実行で接続 3 本) — 逆要求はどの接続にも来る前提で処理する | 多重化を実装 |
| D4 | launch 前の setBreakpoints → `verified:false, message:'breakpoint.provisionalBreakpoint'`。停止後に `breakpoint{reason:'changed', verified:true, line, column}` イベント。`source.path` は **小文字ドライブ `c:\Users\...`** (要求は `C:\`)。root 外は `<node_internals>/...` が `path` にも入り `sourceReference` 非 0、`presentationHint:'deemphasize'`。応答の `breakpoints[]` は要求と同順だが **id が重複 (両方 1)・位置が移動する** (import 行 3 と行 7 の 2 件がともに `line:6 column:15`) → クライアントは要求順で対応付け、表示行は応答の `line` を使い、id は当てにしない | 事実 |
| D5 | launch → 最初の `stopped` **252〜586 ms** (子接続確立込み)。`next` ×10 **p50 15 / p95 16 ms**、stepIn 16、stepOut 16。`scopes` 1 ms、`variables(Local)` 3 ms、`evaluate{context:'repl'}` 2 ms。`threads` は 1 本 (`id:0`)、`allThreadsStopped:false` | ✓ 全項目 |
| D6 | `.ts` + `runtimeArgs:['--import','tsx']` (root = prontella、`node_modules/.bin/tsx` あり): `.ts` の行の BP が `verified:true`、`stackTrace.source.path` は `.ts` (小文字ドライブ)、stdout も来る | ✓ 内蔵既定に採用 |
| D7 | `disconnect{terminateDebuggee:true}`: **子接続は成功応答 → ≈500 ms 後に `terminated`**、root 接続への disconnect は**応答が返らない** (5 s TIMEOUT)。root だけに送っても子は 500 ms で `terminated` になり debuggee は消える。**adapter を `kill()` するだけでも debuggee は 434 ms で消える** (孤児にならない) | 手順: root に disconnect (応答は待たない) → 1 s 猶予 → adapter kill |
| D8 | RSS: adapter **77〜78 MB**、debuggee 56 MB。`output` の category: `telemetry` (3〜5 件/実行、捨てる)、`console` (起動コマンド行)、`stdout`、`stderr` | ✓ ≤ 250 MB |
| D9 | `console:'internalConsole'` では `runInTerminal` は来ない。`'integratedTerminal'` では来る: `{kind:'integrated', cwd, args:[node.exe, '.\\app.js'], env:{NODE_OPTIONS:' --require <js-debug>/src/bootloader.js --inspect-publish-uid=http', VSCODE_…}}` — **env を渡せる PTY が無いと成立しない** (後回しのとおり `PtyManager.create` に env 拡張が要る)。断ると停止しない | 事実 |
| D10 | DL 1.25 MB **0.8 s**、`C:\Windows\System32\tar.exe -xzf` **0.06 s**、レイアウト `js-debug/src/dapDebugServer.js` (+ `bootloader.js`、`vendor/`、`ui/`、`targets/`) | ✓ |

## 帰結

- サーバーの `session.ts` は **接続の集合**を持つ: root 1 本 + `startDebugging` ごとに 1 本。ワイヤーは全メッセージに `sessionId`。逆要求はどの接続からも来る
- クライアントは `prontella/session` を受けたら **その sessionId で initialize → setBreakpoints (全ファイル) → configurationDone → `request` (configuration そのまま = サーバーが注入)** を回す。停止・出力は子に来るので、UI の「アクティブセッション」は最後に `stopped` を出したもの
- BP の検証状態は **応答の要求順対応 + `breakpoint` changed イベント**で更新し、表示行は応答の `line`。id は使わない
- パス比較は小文字化 (`safeResolve` と同じ)。root 相対化は `c:\` を `C:\` と同一視する
- 後始末: root に `disconnect{terminateDebuggee:true}` を送り応答を待たず、**1 s 後に adapter `kill()`**。kill 単独でも debuggee は消えるので、これが最終保証
- 内蔵既定: `.js/.mjs/.cjs` は `pwa-node` + `program`、`.ts` は `runtimeArgs:['--import','tsx']` を足す (tsx 不在なら `.ts` は既定を出さない)
- `output` の `telemetry` は捨てる。`loadedSource` は大量 (1 実行で 100 件超) なので**サーバーで捨てる** (MVP は使わない)
- ダウンロード後に `js-debug/package.json` = `{"type":"commonjs"}` を書く

## 実装後の隔離 E2E で分かったこと (2026-09-29、`server/debug/*` 実装後)

- **launch.json の `type: "node"` は素の DAP サーバーが知らず、launch に永久に応答しない** (30 s TIMEOUT)。VS Code は拡張側で
  `pwa-node` に読み替えている。サーバーが `node` → `pwa-node` に書き換える (`resolveLaunchRequest`)。`cwd` の既定
  `${workspaceFolder}` も VS Code が埋めるものなので、無ければ root を入れる
- **PATH の `tar` が GNU tar (Git for Windows の `usr/bin`) だと `C:\...` を「ホスト C のリモート」と解釈して落ちる**
  (`Cannot connect to C: resolve failed`)。cwd を揃えて相対パスで渡せば bsdtar / GNU tar のどちらでも通る
- **`terminalEnv()` の PATH に node が無い** (mise はシェルの profile でだけ PATH に入れる)。js-debug は `runtimeExecutable`
  既定 `node` を PATH から引くので、prontella 自身の node のディレクトリーを PATH の**末尾**に足す (`withNodeFallback`)。
  先頭に足すとユーザーの node より prontella の node が勝ってしまう
- js-debug は `source.name` にも絶対パス (小文字ドライブ) を入れ、起動コマンド行 (`<node.exe の絶対パス> .\src\main.js`) を
  `console` category の output で流す。name が絶対パスなら basename に、output はホームと node のディレクトリーを潰す
- **アダプタープロセスは 1 実行が終わっても自分では終わらない** (複数セッションを受ける作り)。クライアントは root の
  `terminated` (または status failed) で接続を閉じ、サーバーの disconnect → kill に任せる。閉じ忘れると次の開始が黙って空振りする
- 隔離 home (`USERPROFILE` 差替) では **`AppData\Local\Temp` を作っておく**: js-debug が `os.tmpdir()` に `mkdtempSync` して
  無いと即死する (製品の不具合ではない。実 home には必ずある)
- 実測 (E2E): launch.json 経由の launch → 子セッション → `util.js:3` で停止まで ≈ 0.6 s。`next` / `continue` / `evaluate` は
  ブラウザー越しでも体感遅延なし。BP の `verified` は停止直後の `breakpoint` changed で `true` になる
