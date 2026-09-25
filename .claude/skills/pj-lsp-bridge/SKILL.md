---
name: pj-lsp-bridge
description: >
  prontella の LSP ブリッジ (server/lsp/* + client/src/lsp/*) に言語サーバーを足す・
  直す・検証するときの定石。測定スパイク→registry→session→実機の順序とゲート、
  サーバー固有の罠 (tsgo の languageId 固定、Roslyn の意味解析前 completion null と
  1 プロセス 1 ソリューション)、Monaco 側の制約 (内蔵プロバイダー停止は起動時固定、
  registerEditorOpener と peek、定義が自分自身なら参照に落ちる)、フェーズ 2 の罠 (Roslyn は
  全文 didChange で落ちる、tsgo は申告外 triggerCharacter で panic、ソリューション外は misc)、切り分け手順
  (PRONTELLA_LSP_TRACE、/ws/lsp 直叩きプローブ、所有権の奪い合い) まで。
  LSP / 言語サーバー / language server / 補完 / completion / hover / 定義ジャンプ /
  Roslyn / tsgo / typescript-language-server / Monaco プロバイダー / /ws/lsp に触る
  実装・調査タスクを委任するとき、brief の References にこのファイルのパスを入れる。
---

# pj-lsp-bridge — 言語サーバーを足す・直す・検証する定石 (prontella)

## 収録基準

LSP ブリッジ固有で、**コードを読んでも分からない**こと (言語サーバーの実測挙動、Monaco の
登録タイミング、検証で踏んだ罠) だけを書く。設計そのものは `docs/lsp-mvp-plan.md`、測定値と
判断の記録は `scripts/lsp-spike/RESULTS.md` が正。ここは「次に触るときの判断材料」。

## 0. 構造 (どこを触るか)

- ワイヤーは**素の JSON-RPC** (`/ws/lsp?root=&server=`)。独自エンベロープにしない —
  monaco-languageclient へ切り替えるとき `server/lsp/*` を丸ごと残すため
- `server/lsp/registry.ts` 言語表・設定検証・起動コマンド解決 (純関数) /
  `host.ts` (root, serverId, workspace) ごとのプロセス・id 再割当・キュー・クラッシュ制御 /
  `session.ts` 1 WS = 1 (root, serverId)、allowlist、URI 書き換え、所有権、プロセス振り分け
- クライアント `client/src/lsp/`: `languages.ts` (拡張子→languageId→serverId、vitest 対象) /
  `session.ts` (root, serverId) ごとの liveSocket / `documents.ts` モデル同期と所有権 /
  `providers.ts` プロセスで 1 回だけ登録 / `convert.ts` LSP↔Monaco 変換 (vitest 対象)
- **`.tsx` はテスト対象外**。変換ロジックは必ず `.ts` に置く

## 1. サーバーを足す手順 (順序に意味がある)

1. **スパイクを先に書く** (`scripts/lsp-spike/s2.mjs` / `s3-roslyn.mjs` を複製)。測るのは
   initialize 時間・初回可用・ウォーム p50/p95・`positionEncoding`・常駐メモリー・
   `exit` で死ぬか・サーバー→クライアント要求の一覧。**閾値は設計書 §3/§6 のまま、測定後に動かさない**
2. `registry.ts`: `SERVER_IDS` / `EXT_TO_LANGUAGE` / `MODES_BY_SERVER` / `resolveXxx` を足す。
   解決順は「ワークスペース同梱 → config 明示 → 拡張同梱 → PATH → ツール置き場」。
   `.cmd` シムは `shell: true` 無しで起動できないので実体を叩く (`shell: true` は禁止: cp932 化けと注入)
3. `host.ts`: env は必ず `terminalEnv()` (言語サーバーはワークスペースのコードを実行する。
   `pj-child-env` の agentSession と同じ側)。`answerServerRequest` に既定応答を足すのは
   スパイクで「-32601 を返すと機能が欠ける」と分かった要求だけ
4. `session.ts`: プロセスの単位が root より細かいなら `Workspace` キーで振り分ける
   (C# は最寄りの `.sln`)。`completionItem/resolve` は URI を持たないので直前に completion を
   返したプロセスへ
5. クライアント: `languages.ts` に拡張子、`providers.ts` の `LANGUAGES` に Monaco の言語 id、
   `index.ts` で内蔵プロバイダーを落とす必要があるかを判断
6. 単体テスト (`registry.test.ts` の解決順、`session.test.ts` の FakeChild) → 実機 (§5)

## 2. 言語サーバー固有の罠 (すべて実測)

### tsgo (TypeScript ≥ 7、`tsc --lsp --stdio`)
- **TS 7 には `tsserver.js` が無い**。typescript-language-server は initialize で落ちるので、
  `tsserver.js` の存在を条件にする
- **最初の didOpen の `languageId` がそのファイルのスクリプト種別に固定される**。`.tsx` を
  `typescript` で開くと JSX が型アサーション扱いで数百件の構文エラー、閉じて開き直しても直らない
  → `.tsx → typescriptreact` / `.jsx → javascriptreact` は必須 (テストで固定済み)
- `exit` 通知後も生き続ける → 3 秒で `kill()`。definition の URI は `file:///c%3A/...`
  (小文字ドライブ + `%3A`) で来る
- **申告外の `triggerCharacter` を受けると `-32603 InternalError: panic handling request … Unknown
  trigger character`** (`(` `{` で実測)。Monaco には各 LS の和集合を静的に登録しているので、
  クライアントは ready 後に `initialize` で `completionProvider.triggerCharacters` /
  `signatureHelpProvider` を取り、**申告外の文字は Invoked (triggerKind 1) に落として送る**
  (`LspSession.completionTriggers`)。signatureHelp も同じ (申告外だと null が返る)
- **通知が無いと端末や Claude Code が作った/書き換えた/消したファイルを永久に知らない** (auto-import 候補にも
  workspace/symbol にも出ない。Roslyn も同じ)。host が `client/registerCapability` の
  `workspace/didChangeWatchedFiles` 登録 (tsgo は絶対パスの glob、Roslyn は `{baseUri, pattern}` を
  プロジェクトごと) を覚え、`fs.watch(root, {recursive})` → glob 照合 → 300ms でまとめて通知する。
  **initialize で `workspace.didChangeWatchedFiles.dynamicRegistration: true` を申告しないと登録自体が来ない** —
  FakeChild の単体テストは申告を経由しないので通ってしまう。実機では `PRONTELLA_LSP_TRACE=1` の
  `[lsp watch] <root> globs=N` が出るかで確認する
- 診断は pull のみ (`publishDiagnostics` は didChange 後も来ない)。`resultId` 無し、再 pull は 5ms。
  signatureHelp の `activeParameter` はトップレベルに無く signature 側だけ (Roslyn は両方)。
  references は `Location[]`

### Roslyn (`Microsoft.CodeAnalysis.LanguageServer --stdio`)
- **range 無しの全文 didChange (`contentChanges: [{text}]`) で `DidChangeHandler` が
  NullReferenceException を起こしてプロセスごと落ちる** (sync は incremental のみ)。所有権移譲
  (既知 doc への didOpen) と isFlush / isEolChange の両経路がこの形を送っていたので、**session 層で
  didClose → didOpen (+ C# は再温め) に変換する**。修正前は「別プロセスで .cs を書き換えて取り込む」
  だけで落ちていた
- **ソリューションに含まれないファイルは misc 扱い**: 診断に IDE0005「using は不要」が出て hover /
  signatureHelp が null、references が空。製品の不具合と区別がつかない (MSS3.sln は
  `../ftm-backend/...` の別コピーを参照するので `mss3-backend/src/FTM.DataSource/` は misc)。
  「C# で hover が null」はまず**そのファイルが開いた .sln に含まれるか**を疑う
- **1 プロセス 1 ソリューション** (`SolutionPath` が 1 つ)。`--autoLoadProjects` は root 配下の
  全 .csproj (`.claude/worktrees/` の複製まで) を読んで 118 秒 / 900MB → 不採用。
  最寄りの `.sln` を `solution/open` し (25 秒 / ~450MB)、`workspace/projectInitializationComplete`
  まで `starting` に留める
- **意味解析が済む前に来た `textDocument/completion` に null を返し、しかもその doc の以後の
  補完が閉じ直すまで null に固定される** (hover は返る)。固定秒数の保留や hover の先送りでは
  大きいソリューションで効かない。**didOpen 直後に `textDocument/diagnostic` を pull し、その
  応答が返るまでその doc への要求を保留する** (`ProcHandle.warm`)。診断 pull は意味解析の完了と
  同期する。要求は捨てず遅らせる — 捨てると Monaco がその位置を「候補なし」と覚える
- `shutdown` は **`params` を省略すれば `result: null` で正常応答する** (MVP の「.NET 例外で
  終了」は `params: null` を送っていたのが原因。tsgo も null を InvalidParams と言う)。
  サーバー→クライアント要求は来ない。`window/logMessage` は大量に来るので捨てる
- 1 ソリューション 1 プロセスなので**上限 4 に当たりやすい**。同じセッション (ブラウザー) が 4 本を
  持つ限り「セッション無し」条件の LRU は効かないので、**doc を全部閉じたプロセスも LRU で落とす**。
  上限の文言には開いているソリューション名を入れる (どれを閉じれば空くかが分かる)
- 初回 pull (温め) は 25 プロジェクトで 2〜5 秒、didChange 後の再 pull は 0.1〜0.2 秒
  (診断のデバウンス 300ms で足りる)。references は ≈ 2 秒
- `workspace/symbol` は空クエリーに 0 件 (tsgo は全件)、初回 4 秒・以後 30〜150ms。doc を持たない要求なので
  session が**全ソリューションのプロセスへ fan-out して連結**する。補完は常に 1000 件で打ち切られるので
  「新しいファイルが見えているか」の検証は補完の prefix ではなく workspace/symbol で測る
- `dotnet restore` 済みが前提。**隔離 home (`USERPROFILE` 差替) では `~/.nuget/packages` を
  見失い、プロジェクトは読めても参照が解決されず補完/ホバーが null** → C# の実機検証は実 home +
  別ポート (`pj-isolated-verify` の例外規律)

## 3. Monaco 側の制約

- **内蔵 TS プロバイダーの停止 (`setModeConfiguration`) は最初の TS モデル生成前にしか効かない**。
  `initLsp()` は描画前に `/api/lsp/mode` を待つ。設定はグローバルかつ起動時固定 → mode 変更はリロード
- **`registerEditorOpener` は F12 / Ctrl+クリックで呼ばれ、peek (Alt+F12) では呼ばれない**。
  peek はモデルが無いとプレビューが空になるので、`provideDefinition` で対象モデルを事前生成してから返す
- **定義結果がカーソル位置の自分自身なら Monaco は `alternativeDefinitionCommand`
  (= Go to References) に落ちる**。「F12 がファイル内の参照一覧になる」報告は、内蔵 TS が別ファイルを
  解決できず自分の import 宣言を返している症状 (= LSP モードが無効)。まず mode を疑う
- 補完の `CompletionItemKind` は LSP と Monaco で番号が別物 (`convert.ts` の表)。
  `label` は文字列のまま返す (labelDetails は宣言していない)
- **Monaco と同名の汎用クラス (`.main` 等) をグローバル CSS に定義しない** (`pj-client-ui-state` §21)

## 4. 所有権と同期 (壊すと「見た目に何も起きない」)

- LSP は 1 ファイル 1 ドキュメント。同一 root を 2 タイルで開くと 2 モデル → クライアントは owner
  モデルだけが didChange を送り、非 owner から要求する前に全文 didOpen で所有権を取る。
  別ブラウザータブ (= 別セッション) は**サーバーが -32803 not-owner を返し、クライアントが全文
  didOpen して 1 回だけ再要求**する
- `isFlush` (`setValue`: 外部変更の取り込み・再読込) と `isEolChange` は**全文で送る**。落とすと
  LSP 側だけ古い本文で固定され、補完が「少しずれる」形で出るので発見が遅れる。全文は LS へは
  そのまま流さず、**session が didClose → didOpen に変換する** (Roslyn が range 無しで落ちるため。
  languageId は最初の didOpen のものを使う — tsgo は最初の languageId で固定する)
- didChange はデバウンスしない。バージョンは URI 単位の単調カウンター (モデルごとではない)。
  診断の pull だけ 300ms デバウンス (同期はしない)。マーカーは owner モデルだけに付け、
  非 owner・dispose・reset は空で上書き (本文がサーバーと一致しないモデルにマーカーを写さない)
- **死んでいる間 (unavailable / stopped) に届いた didOpen は docs に記録されるだけで LS には流れない**。
  spawn 時に docs を捨てて `$/prontella/reset` を告げ、クライアントに開き直させる (これが無いと
  3 回 kill → 手動再起動の後、補完も診断も空のままになる)
- rootToken は **root 単位** (プロセス単位にするとクライアントの leafId↔token 対応が壊れる)。
  C# はサーバー側が didOpen を受けて初めてプロセスを起動するので、クライアントは
  **token が届いた時点で didOpen を送る** (ready を待つと永久に始まらない)

## 5. 切り分け手順

1. **まず mode**: `GET /api/lsp/mode`。ステータスバーが「TS: 内蔵」なら LSP は動いていない
2. `PRONTELLA_LSP_TRACE=1` でサーバーを起動 → `[lsp >] / [lsp <]` に method/id/エラーが出る
   (本文は出ない)。「要求が LS に届いたか」「null は LS が返したか、セッションが返したか」がここで分かる
3. **ブラウザーを閉じてから** `/ws/lsp` を Node の `ws` で直叩きするプローブを書く
   (didOpen → completion → hover)。開いたままだとブラウザーのセッションが所有権を奪い、
   プローブは not-owner を受ける — 製品の不具合と誤認しやすい
4. それでも LS が null なら、スパイク (`s2.mjs`/`s3-roslyn.mjs`) で LS を直に叩いて
   ブリッジ抜きの挙動と比べる。**成功/失敗の差分を「タイミング・順序・プロセスの新旧」で表にする**
   (Roslyn の R8 は、この表を作るまで hover が原因だと誤認していた)
5. 補完ウィジェットに候補が「ある」のに見えないなら LSP ではなく CSS (`.suggest-icon` の幅・
   `.monaco-icon-label` の位置を `getBoundingClientRect` で測る)

## 6. 実機検証で必ず通す項目

- 別ファイルで定義した関数が候補に出る / F12 で別ファイルへ飛ぶ / peek に中身が出る
- **別プロセスでファイルを書き換え → タブへ戻る → 取り込み後の内容で候補が出る** (isFlush 経路。
  試さないと必ずすり抜ける)。TS は auto-import の `additionalTextEdits` まで確認
- 候補が重複しない (内蔵停止が効いている)
- LS を kill → 次の要求で復帰。C# は 2 ソリューション開いて 2 プロセスになること。
  **60 秒に 3 回 kill → 「LSP: 停止」で固定 → メニュー再起動 → その後に補完と診断が戻る**
  (再起動直後だけ見て終わらない)
- 構文エラーを打つ → 赤波線 (1 件だけ = 内蔵と二重になっていない) → 直すと消える。C# は Info の
  青点線に IDE コードと learn.microsoft.com へのリンクが出る
- `(` で引数表示、`,` で次の引数へ / Shift+F12 で別ファイルの参照が出て peek に中身 /
  root 外 (`lib.dom.d.ts`、Roslyn の metadata-as-source) の F12 が読み取り専用モーダルで該当行に着地し、
  タブ一覧には出ない
- 2 タイルで同じファイル: 片方で編集 → もう片方で補完 → トレースに didClose → didOpen (もう片方の
  全文) が出てから completion が返る
- **端末で新しいファイルを作る → 何もせずに補完** → その export が auto-import 候補に出る (トレースに
  `[lsp watch]` と `workspace/didChangeWatchedFiles`)。Ctrl+P `#名前` でシンボルが出て Enter で着地する
- **エディターを 1 度も開いていない画面**で例外が出ない
- 検証後: サーバー kill、LS の残骸 (`Microsoft.CodeAnalysis.LanguageServer` / `tsc.exe`) 無し、
  実 `~/.prontella/config.json` のタイムスタンプ不変、対象 repo の `git status` が変わっていない
