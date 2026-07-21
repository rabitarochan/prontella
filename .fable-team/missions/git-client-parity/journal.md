# Work journal: git-client-parity

> **Append-only.** Never rewrite or delete past entries. Add new entries at the end.
> Timestamps come from the Conductor — one shell call: capture `ts=$(date '+%Y-%m-%d %H:%M')`,
> print the header from it, append the body with a quoted heredoc (`<<'EOF'`) so the shell never
> interprets body text (procedure: work skill Step 4); when recording is delegated to scribe
> (checkpoints), the brief passes the timestamp (scribe cannot check the clock). Never guess a time.
> Distinguish facts (what was observed) from judgments (what was decided). Leave failures as they happened — do not embellish them.

---

## 2026-07-20 22:01 — Conductor (fable)

- **Did**: ミッション立ち上げ。scout 3 体(検証ハーネス / Git バックエンド / Git タブ UI)で偵察 →
  architect が実行計画を設計 → ユーザーが計画を承認。mission.md / plan.md / state.md /
  delegations.md / journal.md を作成
- **Learned**:(事実)自動テスト・lint は未構築で検証は `npm run typecheck` + `npm run dev` 実操作のみ。
  Git 機能は 3 層パターン(git.ts → index.ts → api.ts)+ gitMode 正規化で統一されている。
  ハンク単位ステージ・コンフリクト解決 UI・rebase 系・タグ管理などが未実装
- **Decisions and rationale**:(判断)ユーザー確認により完了ライン = Phase 0–6 全部、
  除外 = submodule / GPG 署名 / LFS / bisect / 対話的 rebase / クレデンシャル UI(必要時はターミナルで代替)。
  設計判断 (a)〜(e)(サーバー側パッチ組立、Monaco 競合エディタ、ConfirmDialog 統一、
  vitest 純ロジック限定、operation 一般化)は plan.md 参照
- **Next**: Phase 0(0.1〜0.4)を builder に並列委任(state.md の Next move 参照)

## 2026-07-20 22:17 — Conductor (fable)

- **Did**: Phase 0 を builder 3 体に並列委任し、全件受入。0.1 runGitInput(spawn/stdin Buffer)+ 0.2 getOperationState と status レスポンスへの operation 追加(types.ts/api.ts 同期)/ 0.3 ConfirmDialog + useConfirm(ChangesTab の discard を置換、button.danger 追加)/ 0.4 vitest 導入(vitest.config.ts 新設、unquoteGitPath の export 化 + テスト 3 件)。並列作業収束後の統合状態で typecheck・test(3/3)グリーンを Conductor が実測
- **Learned**:(事実)tsconfig の `extends` は `exclude` をマージせず子が親を上書きする — server/tsconfig.json だけに test 除外を書いても tsconfig.build.json 側に効かず dist にテストが出力された(builder C が実測で検出し build 側にも exclude を追加して解消)。native confirm は Git 関連以外も含め 14 箇所残存(builder B レポートに file:line 一覧)
- **Decisions and rationale**: `operation` は BranchStatus 内ではなく status レスポンスのトップレベルに配置(boolean `merging` の後継として同階層が自然、かつ getBranchStatus 非改変の編集制約内で完結するため)。vitest 設定は vite.config.ts(root:'client')と分離した vitest.config.ts をルートに新設(root 解決の衝突回避)
- **Next**: 0.V verifier(dev 起動 + API/スクリプト実測)→ 0.R reviewer ゲート

## 2026-07-20 22:41 — Conductor (fable)

- **Did**: Phase 0 ゲート完了。(1) 0.V verifier: typecheck/test/build、operation 検出の API 実測(null→merge→null)、runGitInput の 1 ハンク実適用(staged/unstaged 併存を porcelain で観測)まで Verified。UI 目視のみ残 → (2) Conductor がブラウザーで実施: スクラッチリポジトリーを一時登録し、ConfirmDialog の表示(danger 赤ボタン・ファイル名・元に戻せません注記)/ Escape キャンセル / バックドロップキャンセル / 破棄確定(ファイル復元)を全経路実測、登録解除・削除まで後始末済み。(3) 0.R reviewer: ✅ LGTM(must-fix 0 / recommended 1 / FYI 5)。(4) recommended #1(runGitInput のメモリ上限ガード欠如)を builder A に SendMessage 継続で委任 → 64MB 共有定数化 + settled ガード共有で実装 → Conductor が 70MB blob の cat-file で発火を実測(日本語メッセージで reject)
- **Learned**:(事実)reviewer は timeout kill の確実性・rebase>merge の優先順位・型同期の完全一致を実測で確認済み。持ち越し FYI: #2 danger ボタンに autoFocus(native confirm と同挙動でリグレッションではない)/ #3 useConfirm のアンマウント時 resolver 未解決(安全側)/ #4 vitest include が .test.tsx を拾わない / #5 status の merging と operation の二重計算 / #6 rebase 中の merging=true の意味差
- **Decisions and rationale**: recommended #1 は Phase 2 でパッチが載る前に即修正(基盤欠陥は後段で増幅)。FYI #2/#3 は非リグレッションのため見送り、#4 は client テスト追加時、#5/#6 は Phase 3 の operation 移行時に織り込む。コミットは規約(Conventional Commits)に沿ってユーザー承認後に実施
- **Next**: Phase 1(1.1 複数行コミット本文 / 1.2 merge opts --no-ff 既定 / 1.3 undo last commit / 1.4 discard all)を builder に並列委任

## 2026-07-20 23:02 — Conductor (fable)

- **Did**: Phase 1 を builder 3 体に並列委任し、全件受入。1.1 コミット本文(getCommitMessage + /api/git/commit-message + HistoryTab に body 表示。入力側 textarea は既に複数行対応で変更不要)/ 1.2 merge opts(noFf/ffOnly/message。UI 既定を --no-ff 化、マージ確認を ConfirmDialog 化。スモークで親 2 つ・FF 成功・FF 不可拒否を実測)/ 1.3 undoLastCommit(初回コミットガード付き)+ 1.4 discardAll(includeUntracked チェックボックス、staged 不変をスモーク確認)。統合状態で typecheck・test 3/3 グリーンを Conductor が実測
- **Learned**:(事実)3 体が同一ファイル(git.ts / index.ts / api.ts)を並行編集したが、領域割り当て(merge() 内 / getCommitFiles 直後 / 末尾)により衝突ゼロ。promise ベースの確認ダイアログに React state のチェックボックスを入れると frozen ReactNode で更新されない問題があり、builder F は useRef + defaultChecked で回避(設計判断として妥当)
- **Decisions and rationale**: 1.1 の body 抽出はクライアント側に配置(サーバーは %B 生値を返す。加工は表示の関心事)。ffOnly でも --no-edit を付与(実害なし・分岐単純化)
- **Next**: 1.V verifier(API 実測 + subdir 正規化確認)→ Conductor のブラウザー UI 検証 → 1.R reviewer ゲート

## 2026-07-20 23:22 — Conductor (fable)

- **Did**: Phase 1 ゲート完了。(1) 1.V verifier: 4 機能すべて API 実測で Verified(複数行本文の往復 / --no-ff 親 2 つ・ffOnly 両挙動 / undo の staged 復帰と初回ガード / discardAll の staged 温存)+ gitMode=subdir 正規化も Verified。(2) Conductor がブラウザーで UI 全経路を実測: 複数行入力→コミット→履歴で body 表示 / undo ダイアログ(直前 subject 表示)→実行 / discard-all danger ダイアログ(件数+チェックボックス)のキャンセル・実行両経路 / ブランチメニューの --no-ff マージ→マージコミット生成。(3) 1.R reviewer: ✅ LGTM(must-fix 0 / recommended 1 / FYI 4)。(4) recommended(HistoryTab の fetch out-of-order レース。既存 commitFiles effect にも同疾患)を builder D に SendMessage 継続で委任 → 2 effect を統合し cancelled ガードで修正(40 秒で完了)。最終 typecheck / test 3/3 グリーン
- **Learned**:(事実)reviewer の実測: マージ中の undo/discard は git 自身が fail-safe に拒否(reset は fatal、restore はアトミック中断で clean も走らない)。subdir 登録でも status と discardAll は共に git root スコープで件数と破棄範囲が一致。ブランチ名のフラグ解釈露出は既存と同水準(git がフラグ様ブランチ名の作成自体を拒否)
- **Decisions and rationale**: FYI 4 件は見送り(マージ中の UI 無効化は Phase 3 の operation 移行で織り込む / merge の `--` セパレーター統一は責務外 / discardAll の VS Code 準拠挙動は妥当 / 新関数の単体テスト不在は verifier 実測+既存テスト密度の慣習に沿う)
- **Next**: Phase 2(ハンク単位ステージ)— 2.1 純関数 splitDiffHunks/buildPartialPatch + vitest → 2.2 apply-hunks API → 2.3 DiffPane ハンク UI

## 2026-07-21 00:57 — Conductor (fable)

- **Did**: 2.1(server/diffPatch.ts + diffPatch.test.ts)を受入。splitDiffHunks / buildPartialPatch 実装、vitest 15/15(往復不変・CRLF・no-newline・非 ASCII・実 git 統合テスト含む)
- **Learned**:(事実・重要)builder がスモークで実バグを検出・修正: 非最終ハンクを単独選択すると末尾改行が失われ `git apply` が corrupt patch で拒否する(git diff テキストは常に末尾 \n を持つという観察が根本)。回帰テストとして vitest に恒久化済み。メタ行(diff --git/index/---/+++/@@)は CRLF ファイルでも \r を持たず、内容行のみ \r を保持する
- **Decisions and rationale**: buildPartialPatch に範囲外インデックス検査を追加(builder 判断を追認 — データ損失リスクの高い関数への防御)。2.2 は同じ builder の SendMessage 継続で実施(diffPatch のコンテキスト保持)
- **Next**: 2.2 apply-hunks API(409 照合 + Buffer/latin1 経路)+ diff-hunks 取得 API → 受入後 2.3 UI を別 builder へ

## 2026-07-21 01:04 — Conductor (fable)

- **Did**: 2.2(apply-hunks API)を受入。getDiffBuffer(git.ts)+ POST /api/git/apply-hunks(latin1 経路、409 分岐は asyncHandler を使わず明示実装)+ GET /api/git/diff-hunks(表示用 utf8)+ api.ts/types.ts 同期。builder の HTTP スモーク a〜e 全通過(MM 併存 / unstage 復元 / discard 片ハンク / CRLF+日本語のバイト保持・U+FFFD なし / 409 で無変更)
- **Learned**:(事実)ハンク境界検出は \n と `@@ ` のみに依存するため、表示用 utf8 パースと適用用 latin1 パースで hunkCount が一致する(コード内コメントに明記させた)
- **Decisions and rationale**: diff コマンド組み立ての重複を避けるため getDiffBuffer を service 層(git.ts)に集約(3 層パターン準拠)。単体テスト追加は見送り、HTTP スモークに検証コストを寄せた(409 分岐はルート層でしか検証できないため)
- **Next**: 2.3 ハンク UI(新規 builder)→ 2.V(CRLF/Shift_JIS 実測)→ Conductor ブラウザー検証 → 2.R

## 2026-07-21 01:15 — Conductor (fable)

- **Did**: 2.3(ハンク UI)を受入。DiffHunkStrip(新規)を DiffPane 内・DiffEditor 直上に配置(HistoryTab 経由の commit 表示と判定を共通化するため)。worktree=ステージ/破棄(danger 確認)、staged=ステージ解除、commit・untracked は非表示。Monaco への revealLineInCenter スクロール連動も実装。vitest 21/21(diffHunk.test.ts 6 件追加)
- **Learned**:(事実)client/src/api.ts の request() は HTTP ステータスを捨てるため、409 判定はサーバー固定文言との文字列一致になっている(builder が脆さを自己申告。HUNK_CONFLICT_MESSAGE 定数に結合をコメント明記)。2.R で要判断
- **Decisions and rationale**: ファイル一覧の即時更新は refreshDeck() まで(ChangesTab の行一覧は 5 秒ポーリング追従)。busy はハンク帯全体で単一フラグ(既存慣習)
- **Next**: 2.V verifier(CRLF/Shift_JIS のバイト実測)+ Conductor ブラウザー UI 検証(409 の UI 経路含む)→ 2.R

## 2026-07-21 13:02 — Conductor (fable)

- **Did**: resume-mission で復旧。journal(2.3 受入、01:15)が state.md(23:25)より先行していたため、
  現実(git status に diffPatch/diffHunk/DiffHunkStrip 一式、vitest 36/36・typecheck green を本セッションで複数回実測)を
  正として state.md と plan.md(2.1〜2.3 ✅)を更新
- **Learned**:(事実)本ミッション休止中に別件一件タスク「エディター状態の永続化」を実施し d8131be として
  本ブランチにコミット済み(styles.css は 2.3 の hunk-strip 分を除いて部分ステージ。ミッションの
  未コミット変更は全て無傷)。副次発見: 選択中 worktree は Windows のファイルロックで
  git worktree remove が失敗する(growth inbox 記録済み、本ミッション Phase 4 以降の UI 磨きで要考慮)
- **Decisions and rationale**: 2.V の隔離検証は editor-persistence 検証で確立した手順
  (USERPROFILE 隔離 + ビルド + tsx 単体起動)を踏襲する
- **Next**: 2.V verifier(CRLF/Shift_JIS 実測)→ Conductor ブラウザー UI 検証(409 経路含む)→ 2.R reviewer

## 2026-07-21 13:16 — Conductor (fable)

- **Did**: 2.V(verifier)を受入。CRLF: hunk0 のみ stage で MM・staged diff にハンク 0 のみ・CRLF(0d0a)保持・U+FFFD 0 件・作業ツリー cmp 一致 / unstage で復帰。SJIS: hunk0 stage 後の staged バイト列が期待 SJIS と cmp 完全一致。discard: hunk1 のみ消え staged 不変。409: index/worktree/両 diff の md5 一致(無変更)を確認。回帰: vitest 36/36・typecheck green
- **Learned**:(事実)Volta 環境でも今回 USERPROFILE 差し替えで node_modules/.bin/tsx.cmd 直接起動が安定動作(シム不安定は再発せず)
- **Decisions and rationale**: UI 実操作は別エージェント(editor-persistence 検証で隔離ブラウザー手順を確立済み)へ SendMessage 継続で委任(コールドスタート回避 + Conductor コンテキスト温存)。検証観点は表示/スクロール連動/stage・unstage/discard 両経路/409 の UI 自動再読込
- **Next**: UI 検証受入 → 2.R reviewer(パッチ正確性重点 + 409 文字列一致判定の脆さの要判断)

## 2026-07-21 13:32 — Conductor (fable)

- **Did**: UI 検証(隔離ブラウザー、editor-persistence 検証エージェント継続)を受入。表示(worktree=stage/破棄、staged=解除のみ、commit=帯なし)/ スクロール連動 / stage で MM・staged 側にハンク単独 / discard の ConfirmDialog 両経路 / 409 の UI 自動再読込+安全拒否 — すべて ✅ 実測
- **Learned**:(事実)発見 2 件: (1) ハンク操作後、同一ファイルの別スコープを表示中の兄弟タブが自動更新されない(操作タブと git 実状態は正しい。「差分を取り直す」で回復)。(2) SJIS ファイルの diff 表示が文字化け(表示系が UTF-8 前提。ハンク分割・stage はバイト正確 — API 層 2.V で確認済み)。(2) は Phase 2 実装起因ではなく既存の diff 表示エンコーディング問題
- **Decisions and rationale**: (1) は 2.3 の修正サイクル(attempt 2)として新規 builder に委任(元 builder は前セッションで消滅)。(2) はゲートブロッカーにしない — 2.R の判断材料に載せ、対応するなら後続フェーズの独立タスク(ユーザー判断)
- **Next**: 修正受入 → UI 再検証(兄弟タブ更新のみ)→ 2.R reviewer

## 2026-07-21 13:36 — Conductor (fable)

- **Did**: 2.3 修正(兄弟タブ自動更新)を受入。DiffHunkStrip に成功時限定の onHunkStateChanged を追加 → DiffPane 橋渡し → DiffTabsPane の notifySiblings が同一 path・別 key のタブへ既存 onReload(gen++ remount = 「差分を取り直す」と同一経路)を発火。409 分岐は無編集。typecheck / vitest 36 green
- **Learned**:(事実)DiffTabsPane は全タブ常時マウント(display:none 切替)のため、非表示の兄弟タブも操作直後にバックグラウンドで再フェッチされる(手動リロードと同挙動)
- **Decisions and rationale**: 409 時は兄弟へ伝播しない(git 実状態が変わっていないため)— builder 判断を追認。ソフト再読込の共有機構は新設せず既存 remount 経路を再利用(最小差分)
- **Next**: UI 再検証(兄弟タブ双方向 + 409 回帰)→ 受入後 2.R reviewer

## 2026-07-21 13:50 — Conductor (fable)

- **Did**: 2.3 修正の UI 再検証を受入(前エージェントのトランスクリプト失効により新規エージェントで実施)。兄弟タブ自動更新を双方向とも実測 ✅ — ネットワークログで apply-hunks 直後に非表示兄弟タブの diff-pair/diff-hunks 再フェッチが**クリック前に**発火することまで確認。操作タブ自身・409 経路(メッセージ+自動再読込+兄弟へ非伝播+index/worktree 無変更)も回帰 ✅
- **Learned**:(事実)SendMessage 継続はエージェントのトランスクリプト失効で失敗し得る(長寿命セッションでは再委任ブリーフを自己完結で書けるよう記録が重要)
- **Decisions and rationale**: Phase 2 ゲートの最終ステップ 2.R reviewer(Opus)を起動。重点: パッチ正確性 / 409 照合が hunkCount のみで足りるか / 要判断 2 件(409 文字列一致判定の債務、SJIS diff 表示文字化けの帰属と時期)
- **Next**: 2.R 判定受入 → 指摘対応(最大 2 サイクル)→ ゲート記録 + checkpoint → ユーザーへ中間報告

## 2026-07-21 13:59 — Conductor (fable)

- **Did**: 2.R(reviewer、Opus)受入。判定 ✅ LGTM(must-fix 0 / recommended 2 / FYI 3)。パッチ生成中核(latin1 保存・CRLF・no-newline・utf8/latin1 hunkCount 一致・64MB ガード・フェイルクローズド)は攻めても不壊。既存 Git フロー無回帰
- **Learned**:(事実)recommended #1: apply-hunks の楽観ロックが hunkCount のみのため、並行編集でハンク数不変のままずれると discard が別ハンクを不可逆破棄(reviewer が実 git で再現)。エージェントがファイルを書き換える本製品では現実的。recommended #2: 409 の文字列一致判定は追跡可能な債務として許容(恒久策 = request() のステータス保持、後続フェーズ)。FYI: SJIS diff 表示文字化けは Phase 0/1 以前からの全域既存問題(適用はバイト正確)— エンコーディング対応は横断課題として後続へ
- **Decisions and rationale**: recommended #1 は Phase 0 の先例(基盤欠陥は後段で増幅 → ゲート内即修正)に従いゲート内修正。方式は reviewer 提案の「選択ハンク header 同一性検証」+ エンコーディングの罠対策(比較は utf8 側権威パース同士)。#2 と SJIS 表示は後続フェーズ送り
- **Next**: 修正受入(HTTP スモークでレビュー再現シナリオが 409 になること)→ reviewer 再確認 → ゲート記録 + checkpoint + ユーザー中間報告

## 2026-07-21 14:26 — Conductor (fable)

- **Did**: 2.R recommended #1 の修正を受入(セッション中断→同 builder を再開、部分差分検証から完遂)。apply-hunks に expectedHeaders を追加し「hunkCount + 選択ハンク header 同一性」の楽観ロックへ格上げ。フェイルクローズド(欠落/型不正/長さ不一致/範囲外 → 409)。比較は utf8 再パース同士(非 ASCII コンテキストの偽 409 回避、根拠コメント化)。HTTP スモーク: レビュー再現シナリオ 409+バイト一致無変更 / 正 header で誤爆なし discard / 欠落 409 / 日本語 header 偽 409 なし。typecheck・vitest 36 green
- **Learned**:(事実)Volta シムは USERPROFILE 上書きで LocalAppData エラー — Volta 実体 node.exe 直叩きで回避(既知 friction の再確認)。セッション中断を挟んでも builder はトランスクリプトから再開し部分差分検証→完遂できた
- **Decisions and rationale**: diffHunk.ts / types.ts は変更不要(expectedHeaders はリクエスト専用)— builder 判断を追認
- **Next**: reviewer 最終確認(SendMessage 継続)→ ✅ なら Phase 2 ゲートクローズ: checkpoint + コミット提案 + ユーザー中間報告

## 2026-07-21 14:29 — Conductor (fable)

- **Did**: **Phase 2 ゲート通過**。reviewer 最終確認 ✅ LGTM — rec#1 修正(header 同一性ロック)を敵対的に追跡し、TOCTOU(検証と適用が同一 diffBuf スナップショット派生で隙なし)/ フェイルクローズドの抜け(範囲外・負インデックスも 409)/ utf8 再パースの整合(hunkCount 一致の根拠)/ 通常フローの偽 409 なし(apply 後 load() 再取得のため)をすべて確認。vitest 36・typecheck green(reviewer 自身も実行)
- **Learned**:(事実)header 完全一致は「先行ハンクの並行編集で行番号だけずれた」場合も 409 になる(保守的だが誤適用ゼロの安全側 — 対応不要と判定)。持ち越し債務: request() のステータス保持(恒久 409 判定)/ SJIS 表示エンコーディング(アプリ横断)/ 選択中 worktree の削除失敗(Windows ロック、editor-persistence 検証で発見)
- **Decisions and rationale**: Phase 2 ゲートは 2.1〜2.3 で判定(plan の規定どおり)。2.4(行単位選択、P1)はゲート外のため未着手のまま — 次を 2.4 にするか Phase 3(コンフリクト解決、P0)にするかはユーザー判断
- **Next**: checkpoint(この記録)→ ユーザーへ中間報告 + コミット提案。再開時はユーザーの選択(2.4 or Phase 3)から
