# 実装計画: Monaco × LSP 連携 MVP（方式 3.3 = 自前の薄い LSP クライアント）

> **この文書について**: 別セッションで実行するための実装計画。作成日 2026-09-11 / 基準コミット `697191d`。
> 記載した `path:line` はこのコミット時点のもの。着手前に現物を確認すること。
>
> **実装後の注記（2026-09-12）**: 本文書どおりに実装済み（`server/lsp/*`, `client/src/lsp/*`）。実装中に前提が変わった点は
> `scripts/lsp-spike/RESULTS.md` を正とする — この repo の TypeScript は 7（`tsserver.js` が無く `tsc --lsp` を使う）、
> `.tsx` は最初の `languageId` で固定される、peek はモデルの事前生成で対応、C#（Roslyn）を 2 つ目のサーバーとして追加し
> 最寄りの `.sln` ごとにプロセスを持つ、Roslyn は意味解析前の completion に null を返すため diagnostic pull で温める。
> §6 の判定（TS の既定を `lsp` へ切り替えるか）は実測が条件を満たしているが未決のまま。

## Context

ファイルパネルの Monaco エディターは現在、内蔵 TypeScript worker だけを使っている。この worker が見えるファイルは**開いているタブのみ**で（`tsWorker.js:36-39` の `getScriptFileNames()` = mirror models + extraLibs）、`tsconfig.json` も `node_modules` の型も読めない。結果として、別ファイルで定義した関数の補完も、ファイルをまたぐ定義ジャンプも効かない。

そこで本物の言語サーバー（LSP）と繋ぐ。`monaco-languageclient` は `monaco-editor` を CodinGame 版フォーク（`@codingame/monaco-vscode-editor-api`）に置き換える設計で、現構成（`monaco-editor` 実体 + `@monaco-editor/react` + Vite `?worker` + Emmet + カスタムテーマ）と同居できないため、**自前の薄い LSP クライアント**を書く。

**決定事項（ユーザー確認済み）**
- MVP の機能: ドキュメント同期 + **補完（+ resolve）+ ホバー + 定義ジャンプ**。診断は含めない
- 内蔵 TS の扱い: 設定 `lsp.typescript.mode` で切替、**既定は `builtin`**（= 既存挙動そのまま）
- フェーズ 0 の測定スパイクを実装前に入れる
- 言語サーバーは検出のみ・同梱しない
- **この方式が難しいと分かった場合は、現在の仕様を保ったまま monaco-languageclient の搭載を検討する** → §7 に判定条件を事前登録し、§2 でその切替コストを最小化する設計にしてある

---

## 1. 実装を規定する既確認事項

いずれも実データ（インストール済み `node_modules` / npm レジストリー / リポジトリー内コード）で確認済み。

| # | 事実 | 根拠 | 帰結 |
|---|---|---|---|
| A | 内蔵 TS プロバイダーの登録は `setupMode` 内で 1 回だけ。`defaults.onDidChange` を購読していない | `monaco-editor/esm/vs/languages/features/typescript/tsMode.js:37, 131`（購読は `workerManager.js:10` の worker 停止のみ） | 内蔵の停止は**最初の TS モデル生成前**にしか効かない。動的トグル不可、ルート単位不可 |
| B | `setupTypeScript` は `onLanguage('typescript')` で起動 = 最初の TS モデル生成時 | `.../typescript/register.js:223` | 上と同じ。設定は起動時に読む |
| C | モデル URI は `Uri.parse('<leafId>/<path>')`。スキーム無しは `file` にフォールバック | `@monaco-editor/react` の `de(e,t)=>e.Uri.parse(t)`、`monaco-editor/esm/vs/base/common/uri.js:47-52` `_schemeFix` | 実際の URI は **`file:///<leafId>/<rel>`**。本物の file URI と同形だが実在しないパスを指す。判別子は第 1 セグメントが既知の leafId か |
| D | `<Editor>` に `language` を渡していないため、言語 id は URI の拡張子から推論される | `EditorGroupPane.tsx:428-436`、`@monaco-editor/react` は `language = defaultLanguage \|\| language \|\| ''` | 拡張子は URI に残るので推論は正しく働く。LSP の `languageId` は別表が要る（`.tsx` → `typescriptreact`） |
| E | `registerEditorOpener` / `ICodeEditorOpener` は monaco-editor 0.56 に存在 | `monaco-editor/monaco.d.ts:1159, 1178` | 定義ジャンプの着地に使える。ただし 3 経路すべてで効くかは未検証（§3 S1 で測る） |
| F | `isFlush` / `isEolChange` が `IModelContentChangedEvent` に存在 | `monaco-editor/monaco.d.ts:2999, 3003` | full sync へ落とす分岐が書ける |
| G | vitest の対象は `server/**/*.test.ts` と `client/src/**/*.test.ts`。**`.tsx` は対象外** | `vitest.config.ts` | 変換ロジックは必ず `.ts` に置く |
| H | `WS_PATHS` / `METRIC_NAMES` / `STRING_RULES` は閉じた allowlist | `server/metrics/names.ts:118, 27-106, 244-273` | `/ws/lsp` 追加時に 3 箇所とも触る。忘れると `WsPath` 型で落ちる |
| I | クライアント設定 UI は存在しない | VNC もメトリクスも config.json / API のみ | MVP の設定は `~/.prontella/config.json` に置く。UI は作らない |
| J | `monaco-languageclient@10.7.0` は `monaco-editor` に依存せず `@codingame/monaco-vscode-editor-api` ほか約 35 パッケージに依存 | npm レジストリーの `dependencies` | 現構成と同居できない。方式 3.3 を採る根拠 |

---

## 2. アーキテクチャ

```
Monaco  registerCompletionItemProvider / HoverProvider / DefinitionProvider
        registerEditorOpener
   │  素の JSON-RPC（URI は file:///<rootToken>/<rel> に正規化済み）
   ▼  /ws/lsp?root=<abs>
server/lsp/session.ts   1 WS = 1 セッション（id 再割り当て・doc 集合・epoch・メソッド allowlist・URI 書き換え）
server/lsp/host.ts      (root, serverId) ごとに LS プロセス 1 つ・参照カウント・アイドル kill・サーキットブレーカー
   ▼  Content-Length フレーミング（server/lsp/framing.ts）
typescript-language-server --stdio   （spawn: process.execPath + cli.mjs、env = terminalEnv()）
```

### 2.1 サーバーは stdio を素通しせず JSON-RPC を解釈する

1. 素通しだと 1 WS = 1 プロセスになり、同じ worktree を 2 タイルで開く・リロードするだけで tsserver が増殖してインデックスがやり直しになる
2. 1 プロセスを複数接続で共有する以上、リクエスト id の再割り当てが要る
3. **サーバー→クライアント要求に誰かが答えないと言語サーバーがハングする**（`client/registerCapability`、`window/workDoneProgress/create`、`workspace/configuration`）。ブラウザーには答えようがない。**未知メソッドは黙殺せず `-32601` を返す**（黙殺はハングになる）
4. `file://` の生成・解釈を `safeResolve` と同じ 1 箇所に閉じ込められる（ブラウザーに `fileURLToPath` 相当は無い）

### 2.2 ワイヤーは素の JSON-RPC にする

`monaco-languageclient` は `vscode-ws-jsonrpc` で**素の LSP を WebSocket から読む**。独自エンベロープにすると、将来 monaco-languageclient へ切り替えるときサーバー側セッション層も書き直しになる。素の JSON-RPC にしておけば、**切替時に捨てるのは `client/src/lsp/*` だけ**で、`server/lsp/*`（フレーミング・ホスト・ライフサイクル・URI 書き換え・プロセス管理）は 100% 再利用できる。これは MVP 投資の大半を保全する。

**URI は依然としてサーバーが書き換える**（クライアントに実パスを出さない方針は維持）。書き換え先を**モデル URI と同形**にするのが要点:

| | 形 |
|---|---|
| ディスク上（LS 側） | `file:///C:/Users/.../claude-deck3/src/a.ts` |
| ワイヤー & クライアント側 | `file:///<rootToken>/src/a.ts` |
| Monaco のモデル URI | `file:///<leafId>/src/a.ts` |

`rootToken` は `/ws/lsp` 接続時にサーバーが払い出す不透明な短い ID（root 1 つに 1 つ）。クライアント側の変換は**第 1 セグメントの入れ替えだけ**（`leafId ↔ rootToken`）で、純関数として `client/src/lsp/uri.ts` に閉じ込めて vitest で固定する。leaf は自分の root を知っているのでトークンも引ける。

root 外のファイル（グローバル TS の `lib.dom.d.ts` など）は `file:///<rootToken>-ext/<opaque>/...` に書き換える。クライアントはこの形を「開けない」と判定するだけ（MVP では中身を読む API を作らない）。

**方向性の防壁**: クライアントは任意の JSON-RPC を投げられるので、セッション層でメソッドを allowlist する。MVP の許可集合は
`textDocument/{didOpen,didChange,didClose,didSave,completion,hover,definition}` / `completionItem/resolve` / `$/cancelRequest` のみ。それ以外は `-32601`。
`initialize` はクライアントから来ても**転送せず**、ホストがキャッシュしている capabilities を返す（プロセスは既に初期化済みのため）。

### 2.3 既存構造との適合

- `/ws/lsp` の追加は `server/index.ts:1669` の分岐を 1 つ増やすだけ。`instrumentSocket(metrics, ws, '/ws/lsp')` → `attachLsp(ws, root)` → `keepAlive(ws)` の既存 4 本と同形
- `keepAlive` はクライアントの `{type:'ping'}` に `{type:'pong'}` を返す（`server/wsKeepAlive.ts:25-62`）。**素の JSON-RPC には `type` フィールドが無いので衝突しない**（`liveSocket` 側も `msg.type==='pong'` だけを内部消費する: `client/src/lib/liveSocket.ts:151`）
- 接続は `openLiveSocket`（`client/src/lib/liveSocket.ts:293`）をそのまま使う。ハンドルの identity が再接続をまたいで不変

---

## 3. フェーズ 0: 測定スパイク（実装前・本体に触らない）

`scripts/` に使い捨てで置く。**ここを通らないと実装に進まない。**

| 測る対象 | 方法 | ゲート条件 |
|---|---|---|
| S1. `registerEditorOpener` が **F12 / Ctrl+クリック / peek(Alt+F12)** の 3 経路で効くか | 最小 HTML + ダミー `DefinitionProvider` + `registerEditorOpener` | peek で効かない場合は §5 Step 8 の設計を「モデル事前生成 + 自前コマンド」に差し替える。**MVP の設計リスク最大点なので最初に測る** |
| S2. `typescript-language-server` の `initialize` 応答時間・初回 completion・ウォーム後 completion の p50/p95 | Node スクリプトで spawn → initialize → didOpen → completion ×10 箇所。本リポジトリー + 大きめの実プロジェクト 1 つ | p95 > 400ms または初回可用 > 30 秒なら**LSP 自体を再評価**（monaco-languageclient に替えても速くならない。§7） |
| S3. `initialize` 応答の `positionEncoding` 実値 | 同上でログ | `utf-16` 以外ならそのサーバーを無効化する実装が必要（UTF-8 ↔ UTF-16 変換層は作らない） |
| S4. `.tsx` に `typescriptreact` を送った場合と `typescript` を送った場合の差 | 対照条件付きで診断件数を比較 | §5 Step 3 の表の正しさを固定する |
| S5. tsserver の常駐メモリー（Windows 実測）、タイル 4 枚相当の合計 | タスクマネージャー | 上限 4 プロセスが多すぎるなら 2 に下げる |
| S6. `spawn(process.execPath, [cli.mjs, '--stdio'])` が動くか（Volta / fnm 管理下を含む） | 実行 | 動かなければ `terminalEnv().PATH` から node 実体を解決する経路に変更 |

S2/S5 の結果は §6 の既定値決定にそのまま使う。**閾値は測定前に固定し、測定後に動かさない。**

---

## 4. MVP のスコープ

**含む**: ドキュメント同期（didOpen/didChange/didClose/didSave）/ 補完 + `completionItem/resolve` / ホバー / 定義ジャンプ / プロセスのライフサイクル管理 / 再接続と再同期 / ステータス表示（ステータスバー 1 項目）/ 設定 `lsp` キー / TypeScript・JavaScript のみ

**含まない**: 診断（`publishDiagnostics` は受け取って**捨てる**）/ SignatureHelp / References / アウトライン / root 外ファイルを開く / 多言語 / OpenVSX / 設定 UI

**永久にやらない**: フォーマット（`formatOnSave` + `.editorconfig` の既存経路と正面衝突する）/ Rename・CodeAction・`workspace/applyEdit`（開いていないファイルの直接書き換えが必要で、draft/dirty/conflict/エンコーディング保持の全経路を通さねばならない）/ Semantic tokens

---

## 5. 実装ステップ

順序に意味がある。Step 1–5（サーバー側）は monaco-languageclient へ切り替えても捨てずに済む部分なので先に固める。

### Step 1 — `server/lsp/framing.ts`（純関数・テスト先行）

`Content-Length: N\r\n\r\n<body>` の読み書き。`createMessageReader(onMessage, onError)` は `push(chunk: Buffer): void`。

- **`N` はバイト数であって文字数ではない**。`Buffer` のまま切り出し、確定後に `toString('utf8')`。文字列連結でバッファリングすると日本語を含む hover/補完で必ず壊れる
- チャンク境界は保証されない（ヘッダーが 2 分割 / 1 チャンクに 3 メッセージ / ボディが 10 分割）
- 未知ヘッダーで死なない。`\r\n\r\n` まで読み、`: ` で分割して `content-length`（小文字化して照合）だけ拾う
- 不正な `Content-Length` は**復帰を試みず `onError`**（同期点が無いので必ず二次被害になる）→ 呼び出し側はプロセスごと捨てる

> `vscode-jsonrpc@9.0.2` の node エントリー（`StreamMessageReader/Writer`、依存ゼロ、node>=14）に差し替える選択肢もある。自作でフレーミング起因のバグが出たら乗り換える。

**テスト** `server/lsp/framing.test.ts`: 1 チャンク 1 通 / 1 チャンク 3 通 / ヘッダー途中で分割 / ボディを 1 バイトずつ push / 日本語本文がバイト数で正しく切れる / 未知ヘッダー混在 / 不正 `Content-Length` で `onError`。

### Step 2 — `server/lsp/uri.ts`（純関数・テスト先行）

- `docToUri(root, rel)`: `safeResolve(root, rel)`（`server/files.ts:15-24`）を**必ず通して** `pathToFileURL().href`
- `uriToWire(root, rootToken, uri)`: root 配下 → `file:///<rootToken>/<rel>`、root 外 → `file:///<rootToken>-ext/<opaque>`（`Map<opaque, absPath>` はセッションが保持。**クライアントから絶対パスを受け取る経路は作らない**）
- `wireToUri(...)`: 逆変換
- `rewriteUris(value, fn)`: 深走査。①`file://` で始まる文字列値 ②**`file://` で始まるオブジェクトのキー**（`WorkspaceEdit.changes` が URI をキーにする）の両方

**テスト** `server/lsp/uri.test.ts`: Windows ドライブレター（`c:` / `C:`）往復 / 空白と日本語を含むパスのパーセントエンコード往復 / root 外判定 / `..` を含む rel が `safeResolve` で弾かれる / `rewriteUris` が入れ子・配列・**キー**を書き換える。

### Step 3 — `server/lsp/registry.ts`（純関数中心・テスト先行）

- 拡張子 → LSP `languageId`（**`.tsx` → `typescriptreact`**、`.jsx` → `javascriptreact` を明示的にテストで固定）
- `languageId` → `serverId`
- `serverId` → 起動コマンドの解決順:
  1. `<root>/node_modules/typescript-language-server/lib/cli.mjs`（**最優先**。ワークスペースの TS と必ず一致する）
  2. `~/.prontella/config.json` の トップレベル `"lsp"` キーの明示指定
  3. `terminalEnv()` の PATH 上の実体（Windows は `.cmd` を `windowsExecutableCandidates()`（`server/childEnv.ts:102`）で実体へ）
  4. 無ければ `disabled`（**エラーダイアログは出さない**。LSP は補助機能で、無い環境が普通）
- 設定の検証は **`server/vnc.ts:30-76` の `checkVncConfig` と同じ作法**: `typeof value !== 'object' || Array.isArray(value)` を先に弾く → 制御文字（`codePointAt <= 0x20`、`0x7f`）を拒否 → 型ごとに範囲チェック

設定の形:
```jsonc
{ "lsp": { "typescript": { "mode": "builtin" | "lsp", "command": "…", "args": ["--stdio"] } } }
```
`server/config.ts` の `DeckConfig` は `[key: string]: unknown` を持つので（`config.ts:15-18`）、`lsp` キーを明示的に型付けして足す。読み書きは既存の `loadConfig`/`saveConfig`（原子的書き込み `writeJsonAtomic`）に乗る。

### Step 4 — `server/lsp/host.ts`

- **キー**: `(正規化 root, serverId)`。root の正規化は `server/files.ts:18` の `safeResolve` と同じ規則（`path.resolve` + Windows は小文字化）
- **spawn**: `spawn(process.execPath, [cliPath, '--stdio'], { cwd: root, windowsHide: true, stdio: ['pipe','pipe','pipe'], env: terminalEnv() })`
  - **`terminalEnv()` であって `childEnv()` ではない**。言語サーバーはワークスペースの `typescript` を読み、`tsconfig.json` の `plugins` に書かれた**ユーザーのコードを実行する**。Volta/fnm/nvm 由来の PATH がユーザーの端末と一致していなければならない（`.claude/skills/pj-child-env` の分類では `agentSession.ts` と同じ）
  - `process.execPath` で `cli.mjs` を直接叩けば `.cmd` シム・`shell: true`・PATHEXT の問題が全部消える。**`shell: true` は禁止**（cp932 化けと注入）
- **参照カウント**: アタッチ中の WS セッション数（`PtyManager` の `sessions`/`session.sockets` と同型: `server/pty.ts:275, 372-447`）
- **アイドル**: 参照カウント 0 が 5 分続いたら `shutdown` → `exit` → 3 秒で `kill()`。**「doc が 0 になった」では殺さない**（tsserver の再インデックスは数秒〜数十秒。タブを閉じるたびにやり直すと体感が壊れる）
- **上限**: 全 root 合計 4 プロセス（S5 の実測で調整）、超過は LRU で落とす
- **stderr**: 末尾 4KB のみ保持（`server/search.ts:113` と同じ）
- **クラッシュ**: 即再起動しない。次の要求で起動。**60 秒に 3 回落ちたら `unavailable` で固定**（クラッシュループ防止）
- **終了処理**: `exited` フラグで二重クリーンアップ防止、全セッションへ通知、Map から削除（`server/pty.ts:345-356` と同型）
- **サーバー→クライアント要求への応答**: `client/registerCapability`・`unregisterCapability`・`window/workDoneProgress/create` → `{result:null}`、`workspace/configuration` → 項目数ぶんの `null` 配列、未知メソッド → `-32601`。`window/logMessage` は既定で捨てる

### Step 5 — `server/lsp/session.ts` + `/ws/lsp` 配線

- 1 WS = 1 セッション。`rootToken` の払い出し、id 再割り当て表、doc 集合、`epoch`、メソッド allowlist、URI 書き換え（Step 2 を両方向に適用）
- 再起動時は `epoch` を上げ、`$/prontella/reset`（通知）を送る → クライアントは全モデルの didOpen をやり直す
- 古い `epoch` の要求は即エラーで落とす（再起動後の LS がまだ知らない doc への問い合わせを防ぐ）
- **root の検証**: `/ws/lsp?root=` をそのまま `cwd` にしない。`/api/fs/*` は任意 root を受けているが**あちらは読み書きだけ、こちらは任意ディレクトリーでのプロセス起動**なので防壁の重みが違う。`config.getRepo` + `worktreeCache`（`server/index.ts:174`）+ `contains()`（`server/index.ts:156-159`）で「登録済み repo の worktree 配下か」を判定する
- 配線: `server/index.ts:1669` に分岐追加。`server/metrics/names.ts` の **`WS_PATHS`(118 行) / `METRIC_NAMES`(27-106 行) / `STRING_RULES`(244-273 行) の 3 箇所**に `/ws/lsp` と新カウンター名を追加

**テスト** `server/lsp/session.test.ts`: `PassThrough` で偽 child を作り、id 再割り当て / 古い epoch の拒否 / allowlist 外メソッドが `-32601` / 重複 didOpen が full didChange になる / 未知のサーバー→クライアント要求に `-32601` を返す。

### Step 6 — `client/src/lsp/{uri,convert}.ts`（純関数・テスト先行）

**必ず `.ts` に置く**（`.tsx` は vitest 対象外 — 事実 G）。

`uri.ts`: `leafId ↔ rootToken` の第 1 セグメント入れ替え。`<rootToken>-ext/` の判定。`${leafId}-conflict/`（競合解決ペイン）の除外は `client/src/components/files/useGitGutter.ts:95-100` と同じ判定を使い回す。

`convert.ts` の落とし穴（テストの本体）:

| 項目 | 内容 |
|---|---|
| Position | LSP 0 起点 / Monaco 1 起点。`toLsp`/`toMonaco` の 2 関数に閉じ込め往復テスト |
| `CompletionItemKind` | **LSP と Monaco で番号が完全に別物**（LSP `Text=1…TypeParameter=25` / Monaco `Method=0, Function=1, …, Snippet=27`）。数値を流すと「変数が全部フォルダーアイコン」になる。全 25 値の明示テーブル |
| `range` | Monaco では必須。`textEdit` が無ければ `model.getWordUntilPosition()` から作る |
| `InsertReplaceEdit` | `{insert, replace}` の 2 レンジ形式で渡す。片方だけだと「識別子の後ろが残る」 |
| `InsertTextFormat: 2` | `InsertAsSnippet` を立てる。`snippetSupport: true` を宣言して未対応だと `${1:arg}` が生で入る |
| `additionalTextEdits` | 自動 import の実体。落とすと「補完は入るが import が付かない」 |
| `documentation` | markdown は `IMarkdownString` に。**`isTrusted`/`supportHtml` は付けない**（言語サーバー出力は信頼できない入力 — `.claude/skills/pj-untrusted-input`） |
| Hover contents | `MarkupContent` / `MarkedString` / `MarkedString[]` の 3 形すべて来る。旧形 `{language, value}` は fenced code に包み直す |
| `LocationLink` | LSP は `targetUri/targetRange/targetSelectionRange`、Monaco は `uri/range/targetSelectionRange`。名前が部分的にしか一致しない |
| `isIncomplete` | Monaco は `incomplete: true`。落とすと候補が古いまま固まる |
| resolve の `data` | 元の LSP アイテムを Monaco アイテムに `Symbol` キーで貼って持ち回る。`data` を落とすと resolve が無意味になる |
| `itemDefaults` | MVP では宣言しない（分岐を減らす） |

### Step 7 — `client/src/lsp/{workspaces,session,documents}.ts`

- `workspaces.ts`: `leafId → {root, rootToken}` のレジストリー。登録は `client/src/components/FilesTab.tsx:726-758` の `registerFilesTab` と同じ effect に併記（`client/src/components/files/transferRegistry.ts:47-59` の Map ベース registry がひな形）
- `session.ts`: root ごとに `openLiveSocket` 1 本 + pending 要求表 + epoch
  - **`onOpen`（初回でも再接続でも）で全モデルの didOpen を送り直す**（`.claude/skills/pj-client-ui-state` §12）
  - **`onPhase('reconnecting')` で pending を全部解決する** — completion は空、definition は `null` で **resolve**（reject ではない）。宙吊りにすると補完ウィジェットが永久にスピナーで張り付き、reject すると `unhandledrejection` に出る
  - `liveSocket.send()` の**戻り値を必ず見る**（未接続時 `false`。無視すると pending がリークする）
  - 上限タイムアウト: completion 3 秒 / hover・definition 5 秒。超えたら空で解決して `$/cancelRequest`
- `documents.ts`: **React ではなく `monaco.editor.onDidCreateModel` / `onWillDisposeModel`**（`useGitGutter.ts:130-140` と同型）。モデルは `keepCurrentModel` でコンポーネントより長生きするので、React に載せると分割・プレビュー往復・再マウントで didOpen/didClose が乱発される
  - **incremental 同期。ただし 3 つの例外で full sync**:

    | 条件 | 該当箇所 | 落とすと |
    |---|---|---|
    | `e.isFlush`（`model.setValue()`） | `useFileEntries.ts` の `applyDiskContent` / `reloadWithEncoding` | **外部変更の取り込み後、LSP のドキュメントだけ古い内容で固定される。見た目に何も起きないので発見が遅れる** |
    | `e.isEolChange` | `EditorGroupPane.tsx:198` の `setEOL` / `formatOnSave` | 行の対応がずれる |
    | `reset`（LS 再起動）後 | — | LS が知らない doc への問い合わせ |

  - `e.changes` は Monaco が後方→前方の順で渡す。**並べ替えない**
  - バージョンは `model.getVersionId()` をそのまま使う
  - **didChange はデバウンスしない**（遅らせると「補完要求時点のサーバー側テキストが古い」という最悪の不整合を生む）
  - **オーナーシップ**: 同一 worktree を 2 タイルで開くと同一パスに 2 モデルができる（LSP は 1 ファイル 1 ドキュメント）。最初に didOpen したモデルがオーナーで、didChange を送るのはオーナーだけ。非オーナーから要求が来たら、そのモデルの全文で full sync してオーナーを移してから要求する。「問い合わせた瞬間のサーバー側テキストは必ず問い合わせ元モデルと一致する」が構成的に保証される
  - `didSave` は `useFileEntries.ts` の `save()` 成功パス（`bumpGitEpoch` の隣）に 1 行足す
  - **既存の draft/dirty とは衝突しない** — LSP 層はモデルの内容とバージョンだけを読み、`entries`/`draft`/`conflict` には書かない。逆方向（フォーマット・rename）を採用しないので書き戻しも無い

### Step 8 — `client/src/lsp/providers.ts` + 定義ジャンプの着地

- **プロバイダー登録はプロセスで 1 回だけ**（モジュールシングルトン）。`FilesTab` は leaf ごとに複数生存する（非表示タイルも `display:none` でマウント継続）ため、フック内で登録すると**候補が leaf の枚数だけ重複する**
- `triggerCharacters` は登録時に固定されるので静的な上位集合を渡し、`initialize` の capabilities が判明した時点で dispose → 再登録
- 各プロバイダーは `model.uri` → `{leafId, path}` → root → セッションを引き、`ready` でなければ即 `undefined`（**未対応 root で待たない**）
- `CancellationToken.onCancellationRequested` で `$/cancelRequest`。**未実装だと tsserver に古い要求が滞留し、打鍵が進むほど候補が遅れる**
- **着地**（S1 の結果で分岐）:
  - S1 が通った場合: `monaco.editor.registerEditorOpener` で `resource` を `{leafId, path}` に戻し、`FilesTab` の `openAtLine(path, line, column)`（`FilesTab.tsx:705-710`）を registry 経由で呼んで `true` を返す。既存の `pendingRevealRef` → `tryReveal()` 経路（`EditorGroupPane.tsx:210`）に合流するので、スクロール・カーソル・viewState の作法が既存と完全に揃う
  - S1 が通らない場合: `provideDefinition` が返る前にモデルを事前生成し、自前コマンドでナビゲートする
- **ジャンプ先の分類**: 同一ファイル内 → Monaco が処理 / root 配下（`node_modules` 含む）→ タブを開く（`MAX_FILE_SIZE` 2MB 超の `.d.ts` は開けないので通知して止まる）/ `<rootToken>-ext` → **開かない**。「ワークスペース外」を通知

### Step 9 — 内蔵 TS の停止と設定

`client/src/monaco-setup.ts` の末尾で、**最初の TS モデルが生まれる前に**決める（事実 A・B）。

```ts
// mode === 'lsp' のときだけ内蔵を落とす。以後の変更はリロードするまで効かない。
if (mode === 'lsp')
  for (const d of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults])
    d.setModeConfiguration({ ...d.modeConfiguration, completionItems: false, hovers: false, definitions: false });
```

- `mode` は `GET /api/lsp/mode`（設定の読み出しだけの軽い endpoint）で取得し、**アプリのレンダリング前に解決する**。既定 `builtin` なので、失敗時も既存挙動に落ちる
- `noSyntaxValidation: false` は維持（診断を出さない MVP では、内蔵の構文エラー表示が唯一のエラー表示になる）
- **既知の制約**: この選択はグローバルかつ起動時固定。LSP 有効な root と無効な root を同時に開いていても一律。ドキュメントに明記する
- **`mode: 'lsp'` なのに言語サーバーが見つからない場合**: 内蔵は既に落ちているので TS の補完が消える。ステータスバーに「LSP: 未検出」と**「内蔵に戻す」アクション**（設定を `builtin` に書き戻してリロード）を出す

### Step 10 — ステータス表示と i18n

- `client/src/components/EditorStatusBar.tsx` に 1 項目追加（`starting` / `ready` / `未検出` / `停止`、メニューから再起動）。props に `on<Action>` を足す既存の作法（`EditorStatusBar.tsx:111-116`）に従う
- 文字列は `client/src/i18n/strings-files.ts` に `'files.lsp.*'` で ja/en 同時追加（`StringKey` は `strings.ts` で自動生成される）

---

## 6. `mode` の既定をいつ `lsp` に切り替えるか（事前登録）

S2/S5 の実測に従う。**この表は測定前に固定し、測定後に閾値を動かさない。**

| 観測 | 決定 |
|---|---|
| 補完 p95 ≤ 150ms **かつ** タイル 4 枚時の合計メモリー ≤ 2GB | 慣らし運転の後、既定を `lsp` へ切り替える |
| 補完 p95 が 150–400ms | 既定は `builtin` のまま。オプトインで提供し続ける |
| 補完 p95 > 400ms **または** 初回可用 > 30 秒 | LSP 採用自体を再評価（§7 の「切替の引き金にならない」欄） |

参考: 内蔵 TS worker と LSP は同じものを測れない。**カバレッジは LSP の一方的な勝ち、レイテンシーとメモリーは内蔵の一方的な勝ち**（内蔵は開いているタブしか見えない — 事実の根拠は §Context）。

---

## 7. monaco-languageclient への切替判定（事前登録）

**monaco-languageclient が解決するのは「クライアント側のプロトコル忠実度」だけ**であり、サーバーの速度・メモリー・プロセス管理は一切変わらない。したがって切替の引き金は**クライアント側の不具合に限る**。

| 判定 | 切替の引き金になるか |
|---|---|
| S1 が失敗し、自前コマンド方式でも peek（Alt+F12）が実現できない | **なる** |
| `convert.ts` 起因の不具合（候補のズレ・snippet の生入り・import 欠落）が実装 2 週間で収束しない | **なる** |
| MVP 後に rename / code action / semantic tokens が必要になった | **なる**（自前で全部書くより移行が安い） |
| 補完 p95 > 400ms、初回可用 > 30 秒、メモリー超過 | **ならない**（同じ言語サーバーを使うので改善しない。LSP 採用自体の再評価） |
| 言語サーバーが見つからない・クラッシュする | **ならない**（サーバー側の問題） |

**切替コスト（見積もりの前提）**: `monaco-editor` を `@codingame/monaco-vscode-editor-api` に置き換え、service-override 系 約 20 + language-pack 13 パッケージを導入し、`@monaco-editor/react`・Emmet（`emmet-monaco-es`）・カスタムテーマ（`monacoThemeName`）・Vite の `?worker` 設定・`monaco-setup.ts` 全体を再検証する。

**捨てる範囲 / 残る範囲**: 捨てるのは `client/src/lsp/*` のみ。`server/lsp/*`（framing / uri / registry / host / session）と `/ws/lsp` は**素の JSON-RPC ワイヤーにしてあるため 100% 再利用できる**（§2.2）。これが MVP の設計方針そのもの。

---

## 8. 検証

### vitest（`.ts` の純関数）
`server/lsp/framing.test.ts` / `server/lsp/uri.test.ts` / `server/lsp/registry.test.ts` / `server/lsp/session.test.ts` / `client/src/lsp/uri.test.ts` / `client/src/lsp/convert.test.ts` — 各 Step に記載した項目。

### 実ブラウザー（`.tsx` とコンポーネント挙動は vitest で守れない。「テストが green」は無罪証明にならない）
`.claude/skills/pj-isolated-verify` の隔離環境で行う。

1. **同期の正しさ（最重要）**
   - 編集 → その場で補完 → **今書いた関数名が候補に出る**
   - **別プロセスでファイルを書き換え → タブに戻る → ディスク取り込み後に補完 → 取り込み後の内容で候補が出る**（= `isFlush` の full sync。**この経路を試さないと必ずすり抜ける**）
   - エンコーディング指定で再読み込み → 同上
2. **候補が重複しない**（`mode: 'lsp'` で内蔵停止が効いている）
3. **複数タイル**: 同じ worktree を 2 タイルで開いて同じファイルを両方で開く → 片方で編集 → **もう片方で補完してもそちらのモデルの内容に基づく候補が出る**（オーナーシップ移譲）
4. **接続の生死**: サーバー再起動後に補完が復帰する（epoch/reset）。PC スリープ → 復帰後に補完が効く（半死ソケット検出）
5. **プロセスの寿命**: 全タブを閉じて 5 分放置で tsserver が消える。ブラウザーのタブを閉じても同じ。**タイル 4 枚で 5 本目が立たない**
6. **クラッシュ**: LS を手動 kill → 次の補完で復帰。3 回連続 kill → `unavailable` で止まりループしない
7. **エディタータブを 1 度も開いていない画面**で初期化が例外を出さない（`.claude/skills/pj-client-ui-state` §5）
8. **入力直後にグループ分割**して `Canceled` 以外の未処理拒否が出ない（pending の解決が正しい）
9. **定義ジャンプ 4 分類**: 同一ファイル / 同一 root の未オープンファイル / `node_modules` の `.d.ts` / root 外（拒否メッセージ）
10. **`mode: 'lsp'` + 言語サーバー無し**で TS 補完が消えることと、「内蔵に戻す」で復帰すること
11. **Windows / macOS 両方**で、空白と日本語を含むパスのリポジトリー

---

## 9. 規模感

| ステップ | 目安 |
|---|---|
| フェーズ 0（S1–S6） | 0.5–1 日 |
| Step 1–3（framing / uri / registry、テスト先行） | 1 日 |
| Step 4–5（host / session / `/ws/lsp`） | 1.5–2 日 |
| Step 6–7（convert / uri / workspaces / session / documents） | 1.5–2 日 |
| Step 8–10（providers / 着地 / 内蔵停止 / ステータス） | 1–1.5 日 |
| 実機検証（§8 の 11 項目、Windows + macOS） | 1 日 |

合計 6.5–9 日程度。Step 1–5 は monaco-languageclient へ切り替えても残る投資。

---

## 10. 未確定のまま残す判断

- **root 外ファイルへのジャンプ**は「開けません」で止める。トークンの失効タイミングと読み取り専用モデルの回収が絡み、本体より複雑になる
- **診断**は MVP に入れない。`publishDiagnostics` は受信して捨てる（マーカーの寿命管理と、内蔵の構文エラー表示との重なりを MVP の検証対象から外すため）
- **多言語対応**は `registry.ts` の表を増やすだけで載る形にしておくが、MVP では TS/JS のみ
- **OpenVSX 経由での言語サーバー取得**は将来拡張。`https://open-vsx.org/api/-/search` が JSON を返し `files.download` に `.vsix` 直リンクが露出していることは確認済みだが、`.vsix` の中身は VS Code 拡張のホスト JS で、素の LSP サーバー実行ファイルとは限らない（activate 関数を通す拡張は VS Code 拡張ホストの部分実装が要る）。`registry.ts` の解決順に 1 段足すだけで載るのでアーキテクチャ上の手戻りは無い
