# 実装計画: LSP 連携 フェーズ 2（残検証・既定切替・診断・SignatureHelp/References・C# UX・root 外ファイル）

> **この文書について**: `docs/lsp-mvp-plan.md`（MVP）の続き。作成日 2026-09-12 / 基準コミット `c5913a6`（main）/
> 作業ブランチ `feat/lsp-phase2`。MVP で変わった前提は `scripts/lsp-spike/RESULTS.md` を正とし、作業の定石は
> `.claude/skills/pj-lsp-bridge/SKILL.md` に従う。記載した `path` は基準コミット時点のもの。

## Context

MVP（TypeScript/JavaScript + C#、補完・ホバー・定義ジャンプ・同期・プロセス寿命・ステータス）は main にマージ済み。
残っているのは (1) MVP の未検証項目、(2) 実測で条件を満たした TS 既定の切替判断、(3)〜(6) MVP でスコープ外にした機能
（診断・SignatureHelp/References・C# の UX・root 外ファイルの閲覧）。本フェーズはこの 6 つを順に実施し、
**(7) 他言語（pyright / gopls / rust-analyzer 等）は次の段階**とする — registry の serverId が一般化された今、
1 言語あたりの追加コストは小さいが、本フェーズは「今ある 2 言語の体験を完成させる」ことに絞る。

**永久にやらない**（MVP 設計書 §4 のまま）: フォーマット・rename・CodeAction・`workspace/applyEdit`・semantic tokens。

## 進め方の原則

- 順序は 1 → 2 → 3 → 4 → 5 → 6。各タスクを 1 コミット以上に分け、`npm test` / `npm run typecheck` green を保つ
- 変換ロジックは `.ts` に置いて vitest で固定（`.tsx` は対象外）。サーバー側は `session.test.ts` の FakeChild で固定
- 実機検証は `pj-isolated-verify`。**C# は実 home + 別ポート**（隔離 home では NuGet が解決されない）。
  TS の隔離検証は `vt/` の小プロジェクトで可
- 言語サーバーの挙動は「たぶん」で書かない。新しい要求（diagnostic / signatureHelp / references）は
  `scripts/lsp-spike/` のプローブで **tsgo と Roslyn の両方**を先に叩き、応答の形（null / 配列 / オブジェクト、
  `LocationLink` か `Location` か）を RESULTS.md に追記してから実装する

---

## 1. MVP の未検証項目を消化する

対象は MVP 設計書 §8 のうち未実施の 3・4・5・6(実機)・8 と、`PUT csharp off`。実装変更は原則なし（不具合が出れば修正）。

| # | 項目 | 手順 | 合格 |
|---|---|---|---|
| 1-1 | 複数タイルのオーナーシップ移譲（§8-3） | 同じ worktree を 2 タイルで開き、同じ `.ts` を両方で開く。片方で編集 → もう片方で補完 | もう片方のモデルの内容に基づく候補が出る（`documents.ts` の `ensureOwner` が全文 didOpen を送る） |
| 1-2 | アイドル停止と上限（§8-5） | 全タブを閉じて 5 分放置 → LS が消える。C# で `.sln` を 4 つ開く → 5 つ目は `unavailable`（上限） | `IDLE_MS` / `MAX_PROCS` どおり。C# は 1 ソリューション 1 プロセスなので **上限 4 に当たりやすい**。当たったときのステータス文言が分かるか |
| 1-3 | スリープ復帰（§8-4） | PC をスリープ → 復帰 → 補完 | `liveSocket` の半死検出で再接続し、`reopenAll` で didOpen が再送される |
| 1-4 | 3 回連続 kill（§8-6） | LS を 60 秒に 3 回 kill | `unavailable` で固定、ループしない。メニュー「再起動」で解除 |
| 1-5 | 入力直後の分割（§8-8） | 補完中にグループ分割 | `Canceled` 以外の未処理拒否が出ない |
| 1-6 | `PUT {server:'csharp', mode:'off'}` | ステータスバーは C# のとき `off` の入口が無い（TS のみ「内蔵に戻す」）→ **C# にも「言語サーバーを止める」項目を足す**（`EditorStatusBar` の `onUseBuiltin` を `onTurnOff` に一般化） | リロード後に C# の項目が消え、`/ws/lsp?server=csharp` が張られない |

結果は RESULTS.md の「実機検証」表に追記。1-2 で上限に当たる体験が悪ければ、C# の `MAX_PROCS` を別枠にするか
LRU でアイドルを落とす（`evictIdle` は既にある）。

## 2. TypeScript の既定を `lsp` に切り替える

MVP 設計書 §6 の判定: 補完 p95 22ms ≤ 150ms かつ 4 本 ≈ 0.9GB ≤ 2GB → 「慣らし運転の後、既定を `lsp` へ」。

- `server/lsp/registry.ts` の `DEFAULT_CONFIG.typescript.mode` を `'lsp'` に。`registry.test.ts` の `DEFAULTS` を追従
- **既存ユーザーの config に `lsp` キーが無い場合も `lsp` になる**（既定が変わる）。内蔵に戻す入口はステータスバーに既にある
- 言語サーバーが見つからない環境（`disabled`）では内蔵が既に落ちているので TS の補完が消える。
  MVP 設計書 Step 9 のとおり「LSP: 未検出」+「内蔵に戻す」が出ることを 1 で再確認してから切り替える
- README の Notes（TS は「off by default」と書いてある）を書き換える

## 3. 診断（pull diagnostics）

### 事前計測（`scripts/lsp-spike/s4-diagnostics.mjs`）
- tsgo: `textDocument/diagnostic` の応答形（`{kind:'full', items}` / `unchanged`）、`resultId` の有無、didChange 後の再 pull の遅延、
  push（`publishDiagnostics`）も来るので **pull だけを使い push は捨てたままにしてよいか**
- Roslyn: 温めで既に pull しているので応答形は既知（`items`）。didChange 後の再 pull にかかる時間、
  `IDE0xxx` のような提案系（severity Hint/Info）の量
- 判定: 再 pull が 1 秒を超えるなら didChange 後のデバウンス幅を広げる（初期値 300ms）

### サーバー
- `session.ts` の `ALLOWED_REQUESTS` に `textDocument/diagnostic` を追加（応答の URI 書き換えは `rewriteUris` が拾う。
  `relatedInformation[].location.uri` も対象）
- Roslyn の温め（`ProcHandle.warm`）はそのまま。温め中の doc への diagnostic 要求は他と同じく保留される

### クライアント（`client/src/lsp/diagnostics.ts`、新規・`.ts`）
- 取得のタイミング: didOpen 後 / didChange の **300ms デバウンス後**（同期そのものはデバウンスしない — MVP の不変条件）/
  reset 後の再 didOpen 後。要求は `documentFor(model).request` 経由（所有権・キャンセルを共通化）
- `convert.ts` に `toMonacoMarkers(items)`: severity `1..4` → `MarkerSeverity.Error(8)/Warning(4)/Info(2)/Hint(1)`、
  `code`（string | number | `{value, target}`）、`tags`（Unnecessary=1 → `MarkerTag.Unnecessary`、Deprecated=2）、
  `relatedInformation` は同一 root 内のみモデル URI へ（root 外は落とす）。vitest で固定
- 反映: `monaco.editor.setModelMarkers(model, 'lsp', markers)`。**owner は `'lsp'` 固定**（内蔵 TS の owner `'typescript'` と分ける）
- **マーカーの寿命**: モデル dispose（`untrack`）/ LS の reset / 所有権を失ったモデル（非 owner）では **空で上書き**して消す。
  非 owner のモデルはサーバー側の本文と一致していないので、owner のマーカーをコピーしない（位置がずれる）
- 内蔵 TS との重なり: TS を `lsp` にすると `noSyntaxValidation: false` の内蔵構文エラーと LSP の構文エラーが**二重に出る**。
  `initLsp()` で TS が `lsp` のときは `noSyntaxValidation: true` にして内蔵を落とす（診断は LSP が担う）。
  builtin のときは従来どおり
- 提案系（Hint）が多いと目障りになる → 初期値は **Hint を表示しない**（設定は作らない。必要になったら `lsp.diagnostics`）

### 検証
- 構文エラーを打つ → 300ms 後に赤波線、直すと消える / 別ファイルの型を壊す → 開いている参照側に出る（Roslyn は 25 プロジェクトで数秒）/
  タブを閉じて開き直しても古いマーカーが残らない / LS を kill → 復帰後に再取得 / 2 タイルで開いた非 owner 側にマーカーが出ない

## 4. SignatureHelp と References

### 事前計測（`s4-diagnostics.mjs` に相乗り）
- `textDocument/signatureHelp` の `triggerCharacters` / `retriggerCharacters`（tsgo: `( , <` `)`、Roslyn は initialize で確認）と応答形
- `textDocument/references` の応答（`Location[]`。Roslyn はメタデータ参照を返すか）

### SignatureHelp
- `providers.ts` に `registerSignatureHelpProvider(LANGUAGES, {...})`。トリガー文字は静的な和集合（補完と同じ方針）
- `convert.ts`: LSP `SignatureHelp` → Monaco（`signatures[].label/documentation/parameters[].label`（string | [start,end]）、
  `activeSignature` / `activeParameter` の null → 0）。`context.triggerKind` は Monaco 1..3 と LSP 1..3 で**同じ番号**だが
  `isRetrigger` / `activeSignatureHelp` は Monaco → LSP の `context` にそのまま渡す。戻り値は `{ value, dispose() {} }`
- `session.ts` の allowlist に `textDocument/signatureHelp`。タイムアウトは補完と同じ 3 秒

### References
- `registerReferenceProvider(LANGUAGES, {...})` → `textDocument/references`（`context.includeDeclaration: true`）
- 結果は `Location[]` → root 内は `ensureModel` で**モデルを事前生成**（peek のプレビューに必要。定義ジャンプと同じ理由）、
  root 外は落として件数を通知。**事前生成は 50 件で打ち切り**（それ以上は「先頭 50 件のみ」と通知）— 大きい repo で
  数百モデルを作らないため
- これで「定義が自分自身 → `goToReferences`」の受け皿ができる（今は C# だと内蔵の参照プロバイダーが無く止まる）
- allowlist に `textDocument/references`

### 検証
- `(` を打つと引数の表示が出て `,` で次の引数へ / 定義位置で F12 → 参照 peek が別ファイルの参照を含む / Shift+F12

## 5. C# の UX

- **解析中の表示**: 温め（diagnostic pull 待ち）の間、ステータスに `LSP: 解析中` を出す。サーバーの `$/prontella/status` に
  `warming: <件数>` を載せ、クライアントは `warming > 0` で文言を変える（state は `ready` のまま。補完要求は保留され
  3 秒でタイムアウトするので、文言が無いと「効かない」に見える）
- **ソリューションの固定**: `lsp.csharp.solution`（root 相対 or 絶対）を設定できるようにする。`checkLspConfig` で制御文字を弾き、
  `session.ts` の `slotFor` は設定があれば `findSolution` を使わず全 doc をそのソリューションのプロセスへ。
  `.sln` が見つからない doc（misc 扱い）にも効く
- **初回ロードの進捗**: Roslyn の `window/_roslyn_showToast` と `$/progress` は使わない（来ない/不安定）。`starting` の
  tooltip にソリューション名は出ているので、経過秒数を足す程度に留める
- **上限に当たったとき**: 1-2 の結果次第。文言に「開いているソリューション数」を含める

## 6. root 外ファイルの閲覧（読み取り専用）

対象: `lib.dom.d.ts`（root 外の TS インストール）、Roslyn の metadata-as-source（`-ext` トークンになる定義先）、
および root 内でも `MAX_FILE_SIZE`（2MB）を超える `.d.ts`。

### 設計
- **タブにしない**。ファイルタブは root 相対パスがキーで、draft / dirty / conflict / エンコーディングの全経路が root 内前提。
  代わりに **読み取り専用ビューアーのモーダル**（`BlameModal.tsx` / `FileHistoryModal.tsx` と同じ作法、Monaco を 1 つ持つ）で開く
- サーバー: `session.ts` に `$/prontella/readExternal { uri }` 要求（allowlist 追加）。`-ext` URI をプロセスの `ExtTable` で
  絶対パスに戻し、**サイズ上限 4MB**（`lib.dom.d.ts` 2.3MB が入る）で読んで `{ name, text, languageId }` を返す。
  root 内の 2MB 超ファイルも同じ経路で読む（`docToUri` を通すので root 外脱出は無い）。書き込み経路は作らない
- クライアント: `providers.ts` の `provideDefinition` で `external` / 開けない root 内ファイルを捨てる代わりに、
  **`prontella-ext:` スキームの読み取り専用モデル**を作って LocationLink を返す（peek でも中身が出る）。
  `registerEditorOpener` で `prontella-ext:` を受けたらモーダルを開く（`workspaces.ts` の handle に `openExternal(uri, line)` を足す）
- モデルの回収: モーダルを閉じても残る。**`prontella-ext:` モデルは 20 件を超えたら古いものから dispose**（LRU）。
  トークン（opaque id）はプロセスの再起動で失効するので、失効後の要求は `null` → 「開けません」通知
- 4 の References でも同じビューアーを使う（root 外の参照は捨てずにモーダルで開ける）

### 検証
- TS: `console` の F12 → `lib.dom.d.ts` がモーダルで開き該当行へ / Roslyn: `Console` の F12 → メタデータソース（`-ext`）
- 編集できない・保存できない・タブ一覧に出ない / 21 件目で最古が消える / LS 再起動後の古いリンクは「開けません」

---

## 次の段階（本フェーズに含めない）

**7. 他言語の追加** — `registry.ts` の `SERVER_IDS` / `EXT_TO_LANGUAGE` / `resolveXxx`、`client/src/lsp/languages.ts`、
`providers.ts` の `LANGUAGES` を足し、サーバーごとの罠をスパイクで測る。候補と要点:
- **Python / pyright**（`pyright-langserver --stdio`、npm global or `pip`。仮想環境の検出が論点）
- **Go / gopls**（`gopls serve`、`go.mod` 単位。モジュールキャッシュはホーム直下 → 隔離 home 不可）
- **Rust / rust-analyzer**（`rustup component`。初回 `cargo check` が長い → C# と同じ「解析中」表示を流用）
- 共通: 内蔵プロバイダーが無いので TS のような停止処理は不要。`mode: lsp | off`、既定 `lsp`

---

## 検証（全体）

- `npm test` / `npm run typecheck` green（新規: `convert.test.ts` の diagnostics / signatureHelp / references 変換、
  `session.test.ts` の allowlist 拡張・`readExternal`・`lsp.csharp.solution` の振り分け、`registry.test.ts` の既定変更と設定検証）
- 実機（TS は `vt/` 隔離、C# は実 home + 4711）: 各タスクの「検証」項目 + MVP §8 の回帰（別ファイル補完 / isFlush 経路 / 候補非重複 / kill 復帰）
- 後始末: LS の残骸なし、実 config 不変、対象 repo の `git status` 不変

## リスク

- 診断の二重表示（内蔵構文エラー + LSP）— 3 で内蔵を落とすが、`disabled` 環境（LS 無し）では内蔵の構文エラーも消える → 1 の「未検出」表示で気づける
- Roslyn の大きいソリューションでは didChange 後の再 pull が数秒かかりうる → デバウンス幅は計測で決める
- References の事前生成で大量のモデルが生まれる → 50 件上限と、6 の LRU 回収
- 既定を `lsp` にすると、TS 7 の repo では `tsc --lsp` が root ごとに 1 プロセス（226MB）立つ → 上限 4 の体験を 1-2 で先に確認
