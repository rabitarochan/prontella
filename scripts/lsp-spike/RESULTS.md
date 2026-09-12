# フェーズ 0 測定結果（2026-09-11、Windows 11 / Node 24.18.1 (Volta) / monaco-editor 0.56）

閾値は `docs/lsp-mvp-plan.md` §3 / §6 のとおり（測定後に動かしていない）。

## 前提の変更: この repo の TypeScript は 7.0.2（Go 製）

- `node_modules/typescript/lib` に `tsserver.js` が**無い** → `typescript-language-server` は initialize で失敗する
  （`The TypeScript of the workspace (TypeScript 7.0.2 ...) provides no tsserver.js`）
- 代わりに TS 7 は **LSP サーバーを内蔵**する: `node_modules/@typescript/typescript-win32-x64/lib/tsc.exe --lsp --stdio`
  （実体パスは `typescript/lib/getExePath.js` が解決。`serverInfo: { name: "typescript-go" }`）
- 帰結: registry の解決順は **(1) TS ≥ 7 なら tsgo `--lsp`、(2) TS 5 系（`tsserver.js` あり）なら typescript-language-server** の 2 経路

## S2 / S3 / S5 / S6

| | tsgo (TS 7.0.2, 本 repo) | typescript-language-server 6.0.0 + TS 5 (scratch 3 ファイル) |
|---|---|---|
| S6 spawn | `tsc.exe --lsp --stdio` 直接 ✓ | `process.execPath cli.mjs --stdio` ✓（Volta 下で動作） |
| S2 initialize | 94 ms | 1886 ms |
| S2 初回補完（可用） | 818 ms（spawn から 969 ms） | 5114 ms（初回は 0 件、2 回目から 20 件） |
| S2 ウォーム補完 | **p50 7 ms / p95 22 ms**（10 箇所） | 115 ms（1 箇所のみ） |
| S3 positionEncoding | `utf-16` | `undefined`（LSP 3.16 → 既定 utf-16） |
| textDocumentSync | `{openClose, change: 2, save}` | `2`（**数値形**も来る） |
| S5 常駐メモリー | **226 MB**（1 プロセス）→ 4 本で ≈ 0.9 GB | 406 MB（node 4 プロセス、極小プロジェクト） |
| shutdown / exit | shutdown 2 ms で応答、**`exit` 後も 3 秒以上生存** → host は `kill()` 必須 | exit code 0 で終了 |
| 診断 | pull (`diagnosticProvider`) + push の両方 | push のみ |
| サーバー→クライアント | `window/logMessage` を頻繁に送る | — |
| definition の URI | `file:///c%3A/Users/...`（**小文字ドライブ + `%3A`**） | `file:///c%3A/...`（lib.d.ts = root 外） |

**§6 判定**: p95 22 ms ≤ 150 ms かつ 4 本 ≈ 0.9 GB ≤ 2 GB → 「慣らし運転の後、既定を `lsp` へ」の行に該当。MVP では既定 `builtin` のまま（設計書の決定どおり）。

## S4: `.tsx` の languageId

- tsgo は **最初の didOpen の languageId をそのファイルのスクリプト種別として固定**する。
  `FilesTab.tsx` を `typescript` で開く → 502 件の「Type expected」（JSX を型アサーションとして解釈）。
  didClose → `typescriptreact` で開き直しても 502 件のまま（固定される）。
  逆順（`typescriptreact` を先）→ 0 件、その後 `typescript` でも 0 件
- 帰結: `.tsx → typescriptreact` / `.jsx → javascriptreact` は必須。registry のテストで固定する

## S1: `registerEditorOpener`（monaco-editor 0.56、実ブラウザー）

| 経路 | provider | `openCodeEditor` | 結果 |
|---|---|---|---|
| F12 | 呼ばれる | **呼ばれる**（resource=対象 URI, selection=range） | ✓ |
| Ctrl+クリック | 呼ばれる | **呼ばれる** | ✓ |
| Alt+F12 (peek) | 呼ばれる | 呼ばれない | モデルが無いとプレビューが空（参照一覧には出る） |
| Alt+F12、対象モデルを事前生成 | 呼ばれる | 呼ばれない | **プレビューに中身が出る** ✓ |

**Step 8 の設計**: `provideDefinition` で root 配下の対象ファイルのモデルを事前生成（内容は既存のファイル読み出し API）してから返す。
F12 / Ctrl+クリックは `registerEditorOpener` → `openAtLine` で着地。peek は事前生成したモデルをそのまま表示する。§7 の切替の引き金には該当しない。

## 実機検証（2026-09-11、隔離環境 `vt/lsp-01`: TS 7.0.2 の小プロジェクト + ビルド済み client を port 4711 で配信）

設計書 §8 のうち通したもの:

| # | 項目 | 結果 |
|---|---|---|
| 1 | 編集 → その場で補完に今書いた関数名が出る | ✓ `function zetaFn` を書いた直後の `zet` で `zetaFn, Function` |
| 1 | 別プロセスでファイル書き換え → タブに戻る → 取り込み後の内容で候補が出る (`isFlush` 経路) | ✓ b.ts に外部追記した `fromDiskValue` が a.ts で auto-import 候補に出て、確定で `import { fromDiskValue } from "./b";` が挿入される (additionalTextEdits) |
| 2 | 候補が重複しない (内蔵停止が効いている) | ✓ `config.` で `host` / `port` が 1 件ずつ |
| 4/6 | LS を手動 kill → 次の補完で復帰 | ✓ `Stop-Process tsc` 後の `config.` で候補が返る |
| 7 | エディター未生成の画面で例外が出ない | ✓ デッキ画面でコンソールエラー無し |
| 9 | 定義ジャンプ: 別ファイル (F12 で a.ts が開きカーソルが定義位置) / peek (Alt+F12 で a.ts の**編集中の内容**がプレビューされる) / `node_modules` の 2MB 超 `.d.ts` (「定義先を開けません: …lib.dom.d.ts」を通知して止まる) | ✓ |
| 10 | ステータスバー「内蔵の TypeScript に戻す」→ config が `builtin` に書き換わりリロード後は LSP 項目が消える | ✓ |
| — | ホバー | ✓ `const config: { port: number; host: string; }` |
| — | didSave | ✓ Ctrl+S で `textDocument/didSave` が流れる |

未実施: 複数タイルのオーナーシップ移譲 (3)、PC スリープ復帰 (4)、5 分アイドル停止と上限 4 本 (5)、3 回連続 kill (6、単体テストで固定済み)、分割直後の未処理拒否 (8)、macOS (11)。

**解決済み (2026-09-12)**: 補完ウィジェットの候補ラベルが行の外に押し出されて見えなかった件は、アプリのグローバル
`.main { flex-direction: column }` が Monaco の補完行の内側にある同名 `.main` に被さっていたのが原因 (LSP 起因ではない)。
`.app-main` に改名して解消。

**既知の見た目**: peek のタイトルにモデル URI 由来の `\<leafId>\src` が出る (モデル URI の第 1 セグメントが leafId のため)。

**TS 7 workspace の `-ext`**: tsgo は `lib.*.d.ts` を `node_modules/@typescript/typescript-<platform>/lib/` から引くため
root 配下 = `file` 扱いになり、`-ext` になるのは root の外に TypeScript がある構成のみ。

---

# Roslyn (C#) — 2026-09-12、`scripts/lsp-spike/s3-roslyn.mjs`

対象: `C:\HCM\Source\MSS3\MSS3`（`.sln` 9 本 / `.csproj` 約 60、restore 済み）。サーバーは VS Code C# 拡張 2.140.9 同梱の
`Microsoft.CodeAnalysis.LanguageServer.exe`（net10.0 framework-dependent、`--stdio` 対応）。

| | `--autoLoadProjects`（R2） | `solution/open` MSS3.sln のみ（R3） |
|---|---|---|
| initialize | 2.0 s | 1.7 s |
| `projectInitializationComplete` | **118 s**（root 配下の全 .csproj — `.claude/worktrees/` の複製まで読む） | **25 s**（2 回目以降 5〜10 s） |
| 常駐メモリー | 545 MB → 900 MB + BuildHost 116 MB | 350 MB → 633 MB + BuildHost 85 MB |
| mss3-backend のファイル | 別プロジェクトの型を解決、IDE 診断のみ | 同左 |
| bss-backend のファイル | 同上（全部読んでいるので） | **未解決（misc 扱い、補完 0 件）** |
| ウォーム補完 | p50 11 ms / p95 72 ms | p50 12 ms / p95 58 ms |

- R1: `positionEncoding` は未申告（= utf-16）。sync は incremental。補完は常に `isIncomplete: true`、`textEdit` と `data` あり、resolve 可
- R5: `shutdown` 要求に応答せず **.NET 例外で終了**（exit code 0xE0434352）。BuildHost の子プロセスは親と一緒に消える。`--extensionLogDirectory` は無くても起動し、自分で作る（中身は空のまま）
- R6: サーバー→クライアント要求は **無し**。通知は `window/logMessage`（大量）、`window/_roslyn_showToast`、`workspace/projectInitializationComplete`
- R7: 定義は `Location` 形（`LocationLink` ではない）。`file:///C:/...`（大文字ドライブ）

**採った設計**: 最寄りの `.sln`（ファイルのディレクトリーから root へ遡って最初）ごとに 1 プロセス、`solution/open`、
`projectInitializationComplete` まで `starting`。`--autoLoadProjects` は不採用（118 s / 900 MB）。

**R8（実装後に判明）: doc の意味解析が済む前に来た `textDocument/completion` に null を返し、しかもその doc の以後の
補完が didClose/didOpen し直すまで null のまま固定される**（invoked でも trigger でも。hover は正常に返る）。
試した順に: (a) 固定 1.5 秒の保留だけ → BSS.sln は通るが MSS3.sln（25 プロジェクト）は null、(b) didOpen 直後の hover + 保留
→ 同上、(c) **didOpen 直後に `textDocument/diagnostic` を pull し、その応答が返るまでその doc への要求を保留** → 両方通る
（診断 pull は意味解析の完了と同期する。MSS3.sln で ≈ 5 秒）。採ったのは (c)（`ProcHandle.warm`、応答は捨てる）。
保留中の要求はクライアント側 3 秒でタイムアウトするので、開いた直後の数秒は候補が出ない（ready 直後の 1 回だけ）。

**実機検証（実 home、port 4711、MSS3 repo 登録済み）**: `mss3-backend` の `.cs` で `IOptions<T>.Value.` → `BisuAiOptions` の
メンバー（`BaseUrl` / `ExeName` / `LocalPath` …、NuGet 由来の拡張メソッドも）、ホバー、F12 で
`MSS3.Domain/System/UsageModeType.cs:13`（別プロジェクト）へ。`bss-backend` の `.cs` を開くと 2 本目のプロセス（BSS.sln）が立ち、
`_blobService.` → `IBlobService` のメンバー。2 本 kill → 次の要求で両方復帰。

**隔離 home の罠**: `USERPROFILE` を差し替えた隔離環境では Roslyn（MSBuild/NuGet）が `~/.nuget/packages` を見失い、
プロジェクトは読めても参照が解決されず補完/ホバーが null になる（pj-isolated-verify の例外規律に該当）。C# の検証は実 home + 別ポートで行う。
