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
