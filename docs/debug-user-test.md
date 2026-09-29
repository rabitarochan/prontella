# デバッガー (DAP) MVP — ユーザーテスト手順

> 対象: `feat/debugger-dap` (5770119)。所要 20〜30 分。各項目の「期待」と違ったら、その項目番号と画面の状態を報告してください。
> 自動検証 (隔離 E2E) では通っている項目なので、ここで見るのは**実環境 (実 home・実 PATH・実ブラウザー) での差**です。

## 0. 準備

1. ブランチを取り込み、依存を入れて起動する
   ```
   git switch feat/debugger-dap
   npm install
   npm run dev          # vite 8110 / server 3711
   ```
   トレースが欲しければ server 側だけ `PRONTELLA_DAP_TRACE=1 npm run dev:server` (別ターミナルで `npm run dev:client`)。
   `[dap >] / [dap <]` に command / event / seq が出ます (本文は出ない)。
2. **テスト用リポジトリー**を 1 つ用意して prontella に登録する (prontella 自身でも可 — `scripts/dap-spike/fixture/` に
   `app.js` / `app.ts` があり、`node_modules/tsx` もある)。別リポジトリーを使うなら次を置く:
   ```
   src/util.js   export function helper(x) { const doubled = x * 2; return doubled + 1; }
   src/main.js   import { helper } from './util.js'; const a = helper(20); console.log('main a =', a); setTimeout(() => console.log('done'), 100);
   package.json  { "type": "module" }
   ```
3. 初回だけ: `~/.prontella/tools/` が**無い**ことを確認しておく (項目 1 で自動ダウンロードを見るため)。

## 1. 初回起動と自動ダウンロード

- [ ] タイルのアクティビティバー (左の縦並び) に 5 つ目の **虫アイコン (デバッグ)** がある。押すとデバッグビューに切り替わる
- [ ] ファイルビューで `src/main.js` (または `scripts/dap-spike/fixture/app.js`) を開いてから、デバッグビューのピッカーに
      **「アクティブファイルを実行 — src/main.js」** と出て、▶ が押せる
      (`.py` や `.md` を開いていると無効化される。`.ts` は root に `node_modules/tsx` があるときだけ有効)
- [ ] ▶ を押す → 状態が **「vscode-js-debug をダウンロードしています」→「アダプターを起動しています」→「実行中」→「終了」** と進む
      (初回のみダウンロード。通常回線で数秒)。コンソールに `<node>\node.exe .\src\main.js` の行と `main a = 41` / `done` が出る
- [ ] `~/.prontella/tools/js-debug/1.140.0/js-debug/src/dapDebugServer.js` と同階層の `package.json` (`{"type":"commonjs"}`) ができている。
      `.part` / `.tmp` / `.tar.gz` の残骸が無い
- [ ] ▶ をもう一度押す → 今度はダウンロード無しで「アダプターを起動しています」から始まる (状態のツールチップに `adapter: tools`)

**ダウンロードできない環境 (プロキシ等) の場合**: 状態が「終了」+ 赤字のエラーになる。手動で tarball
(<https://github.com/microsoft/vscode-js-debug/releases/download/v1.140.0/js-debug-dap-v1.140.0.tar.gz>) を展開し、
`~/.prontella/config.json` に `"debug": { "node": { "dapDebugServer": "<展開先>/js-debug/src/dapDebugServer.js" } }` を書いてから
再試行。展開先に `package.json` = `{"type":"commonjs"}` を置くこと。

## 2. ブレークポイントと停止

- [ ] エディターで `src/util.js` を開き、**行番号の左 (グリフ余白)** の 3 行目をクリック → **赤丸**が付く (もう一度で消える)。
      行番号そのものをクリックしても付かない (行選択のまま)
- [ ] `src/main.js` をアクティブにして ▶ → **util.js の 3 行目で停止**: 行が黄背景 + 矢印、状態が「停止中 (breakpoint)」、
      赤丸が塗りつぶし (未検証なら中抜き)
- [ ] コールスタックに `helper  util.js:3` と `<anonymous>  main.js:2`、その下に `<node_internals>` のフレームが薄い色で並ぶ
- [ ] 変数の `Local: helper` が自動で開き `x 20` と `this undefined`。`Module` / `Global` は畳まれていて、クリックで開く
- [ ] コンソールの入力欄に `x * 3` + Enter → `60`。存在しない変数 (`zzz`) → 赤字で `ReferenceError` の本文

## 3. ステップと着地

- [ ] ステップオーバー (F10 / ⤵ ボタン) → 4 行目へ。変数に `doubled 40` が増える
- [ ] コールスタックの **`main.js:2` をクリック** → 上のファイルビューが `main.js` タブに切り替わり 2 行目が黄背景。
      変数が Module スコープ (`helper ƒ …`) に変わる
- [ ] ステップアウト (Shift+F11) → main.js 側で停止。ステップイン (F11) は関数呼び出し行で中へ入る
- [ ] 続行 (F5 / ▶) → プログラムが最後まで走り、状態「終了」、黄背景が消え、赤丸は塗りのまま残る
- [ ] キー操作 (F5/F10/F11) は**デバッグビューにフォーカスがあるときだけ**効く (エディターで F5 を押してもブラウザーの
      リロードにならない — Monaco 側が食う)

## 4. 停止・再開始・切断

- [ ] 停止中に ■ (停止) → 「終了」になり、`tasklist | findstr node.exe` に被デバッグの node.exe が残らない (数秒待つ)
- [ ] 「終了」のあと ▶ → 再び BP で止まる (**2 回目以降が空振りしない**こと)
- [ ] 実行中 (停止中) にサーバーを Ctrl+C で落とす → 数秒以内に「終了」になり、**ブラウザーが `/ws/debug` へ再接続を繰り返さない**
      (DevTools の Network → WS に新しい接続が増え続けない)。サーバーを再起動して ▶ で復帰

## 5. launch.json

テスト用リポジトリーに `.vscode/launch.json` を置く (コメントと末尾カンマ入りで OK):
```jsonc
{
  "version": "0.2.0",
  "configurations": [
    { "type": "node", "request": "launch", "name": "Launch main.js", "program": "${workspaceFolder}/src/main.js", "console": "integratedTerminal", },
    { "type": "pwa-node", "request": "launch", "name": "Bad config", "program": "${env:HOME}/x.js" },
    { "type": "coreclr", "request": "launch", "name": "C# thing" },
    { "type": "node", "request": "bogus", "name": "Broken" },
  ]
}
```
- [ ] デバッグビューを開き直す (別ビュー → デバッグ) → ピッカーに **「Launch main.js (launch)」「Bad config (launch)」** が出て、
      `coreclr` と `bogus` は出ない。赤字で「launch.json の警告: 1 件」(ホバーで `Broken: request は …`)
- [ ] 「Launch main.js」で ▶ → util.js:3 で停止 (`console: integratedTerminal` は内部で internalConsole に上書きされる)
- [ ] 「Bad config」で ▶ → 赤字で `対応していない変数です: ${env:HOME}`、起動しない

## 6. 永続化と複数タイル

- [ ] ブラウザーをリロード → 赤丸が復元されている (`localStorage` の `prontella:debug:bps:<root>`)。▶ で止まる
- [ ] タイルを分割して同じ `util.js` を 2 枚開く → 片方でグリフをクリック → もう片方にも即座に赤丸が出る/消える
- [ ] 同じ worktree の別タイルでデバッグビューを開く → 実行状態が共有されている (root 単位)
- [ ] エディターを 1 度も開いていない worktree でデバッグビューを開いても、コンソールにエラーが出ない (DevTools の Console)

## 7. TypeScript (root に tsx がある場合)

- [ ] `scripts/dap-spike/fixture/app.ts` (prontella 自身) の `// BP` の行に赤丸 → アクティブにして ▶ → **`.ts` の行で停止**し、
      コールスタックのフレームが `app.ts` を指す
- [ ] tsx が無いリポジトリーの `.ts` では「アクティブファイルを実行」が無効化され、ヒントに「launch.json か .js/.ts を開いてください」

## 7b. C# (netcoredbg)

前提: .NET SDK が入っていて `~/.prontella/config.json` に `lsp.csharp.dotnetRoot` がある (LSP で C# を使っているなら設定済み)。
テスト用に `dotnet new console -n Hello` を作って登録し、`Program.cs` を次のようにして **`dotnet build`** しておく:
```csharp
static int Leaf(int n) { var doubled = n * 2; return doubled + 1; }   // ← doubled の行に BP
static void Main() { Console.WriteLine("hello"); Console.WriteLine(Leaf(20)); }
```
- [ ] `Program.cs` を開くとピッカーが「アクティブファイルを実行 — Program.cs」で有効。**ビルド前**だと ▶ を押したとき赤字で
      「ビルド済みの bin/Debug/<tfm>/<プロジェクト>.dll が見つかりません。dotnet build してから開始してください」
- [ ] 初回 ▶ → 「vscode-js-debug を…」ではなく netcoredbg のダウンロード (状態は同じ文言「ダウンロードしています」) →
      `~/.prontella/tools/netcoredbg/3.2.0-1092/netcoredbg/netcoredbg.exe` ができる。**初回の起動は 3〜5 秒**かかる (2 回目以降は 1 秒未満)
- [ ] BP で停止: コールスタックが `Program.Leaf()  Program.cs:N`、変数の `Locals` に `n 20` (型つきの値)、コンソールに `hello`
- [ ] ステップオーバー / 続行 / 停止が動き、停止後に `netcoredbg.exe` と `dotnet.exe`(Hello.dll) が残らない
- [ ] `lsp.csharp.dotnetRoot` を config から外して再起動 → ▶ で「終了」+ 赤字 (`configurationDone` の失敗 `0x80070002`)。戻すと動く
      (mise / Volta 等でシェルの profile でだけ dotnet を PATH に入れている環境の確認)
- [ ] launch.json に `"type": "coreclr", "request": "launch", "program": "${workspaceFolder}/bin/Debug/net10.0/Hello.dll"` を書くと
      ピッカーに出て、選んで起動できる

## 8. 見た目 (視覚回帰)

- [ ] **すべてのエディター**の左端が数 px 広がっている (`glyphMargin`)。Git のガター帯 (緑/青/赤) が行番号の左に従来どおり出て、
      赤丸と重なって見づらくない
- [ ] ダークテーマで黄背景・赤丸・矢印が見える
- [ ] デバッグビューを狭くしても 3 段 (コールスタック / 変数 / コンソール) がそれぞれスクロールする

## 報告してほしいもの

- 違った項目番号と、そのときの**状態表示の文言** (「終了」+ 赤字ならその本文 — アダプターの stderr 末尾が入っています)
- `PRONTELLA_DAP_TRACE=1` で起動していれば、該当箇所の `[dap …]` 行 (十数行で足ります)
- 使った node の入れ方 (mise / Volta / nvm / インストーラー) — `terminalEnv()` に node が無い環境は prontella 自身の node で
  実行される設計なので、`console` の 1 行目に出る `<node>\node.exe` がどれを指しているかも
