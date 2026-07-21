# Current state: git-client-parity

> **This file is the single source of truth.** Any session may die at any moment.
> Update it after every task completion and every checkpoint.
> If this file and reality (code, test results) disagree, reality is the truth. Record it in the journal and fix this file.

- slug: `git-client-parity`
- Phase: **Phase 4 完了(ゲート通過)** → 次はユーザー判断(Phase 5 履歴操作 or 2.4 行単位選択)
- Progress: 20 / 30 実装タスク完了(Phase 0〜4: すべてゲート込み ✅。未着手: 2.4(P1)と Phase 5 以降)
- Last updated: 2026-07-21 18:02(Phase 4 ゲートクローズのチェックポイント)
- Updated by: Conductor session (fable)

## Next move (most important)

**Phase 4 完了(4.V 8 項目 E2E ✅ + ゲート内修正 2 件の実機再確認 ✅ + 4.R LGTM、レビュー反映 5 件込み)。
ユーザー承認済み: コミット実施済み + 次は Phase 5(履歴操作)。**

1. **次の一手: Phase 5 開始**(reset 3 種 / cherry-pick / revert / rebase。plan.md L153〜。競合時は Phase 3 の競合 UI へ遷移。5.2/5.3/5.4 は 3.1 依存で相互独立=並列可、ただし同一ファイル群を触るなら Phase 3/4 同様の順次継続が安全)— **新セッションで `/fable-team:resume-mission` から**(本セッションのコンテキストが長い)
2. コミット済み: 318f5eb feat(git) Phase 4 一式(9 files, +602)+ 直後の chore(fable-team) チェックポイント。作業ツリークリーン
3. 2.4(行単位選択)は引き続き未着手の P1 として残存
4. テスト現状: vitest 53 件(diffPatch 15 / diffHunk 6 / editorState 15 / conflictBlocks 12 / parseRemotesOutput 5)+ typecheck green
5. 4.2 で PromptDialog.tsx + usePrompt() 新設(汎用入力モーダル、requestId key で連続プロンプト安全。以後の入力 UI はこれを再利用)

1. 委任方針: 4.1〜4.4 は同一ファイル群(server/git.ts / server/index.ts / client/src/api.ts / GitTab.tsx)を触るため 1 体の builder に順次継続(Phase 3 の判断踏襲)。4.5(リモート管理 UI、M)は builder の文脈が長ければ新規スポーン
2. 4.1 実装形: `POST /api/git/switch` + `track` フラグ / `switchBranchTracking()` / GitTab `remoteBranchMenuItems`(「チェックアウト」)
3. Phase 3 までコミット済み(ac27473 / f8e213e / grow 13f8a57)。Phase 4 実装は作業ツリーに未コミットで蓄積中 → フェーズゲート後にコミット提案
4. テスト現状: vitest 48 件 + typecheck green(4.1 受入時点)

**持ち越し債務(Phase 4 追加分、非ブロッカー)**: Monaco "TextModel got disposed"(diff タブ→履歴切替のコンソールエラー。
Phase 1/2 の diff タブ機構由来と 4.R が判定 — 別課題としてトラッキング)/ PromptDialog の Promise リーク(prompt 待機中の
親 unmount で resolve されず pending 残留。git 操作は飛ばない)/ PromptDialog・ConfirmDialog にフォーカストラップ無し /
listRemotes の複数 pushurl 畳み込み(最後の 1 つのみ保持)

**持ち越し債務(非ブロッカー、記録済み)**: merge 競合の 500 レスポンス(git エラー構造化時に回収)/
409 判定の文字列一致(request() のステータス保持で恒久化)/ SJIS diff 表示の文字化け(アプリ横断)/
マーカーベース解析の原理的限界(列 0 の正当 `=======` で誤認し得る。非サイレント・代替経路あり)/
競合行の discard ボタン(pre-existing)/ 選択中 worktree 削除の Windows ロック失敗

**持ち越し債務(いずれも記録済み・非ブロッカー)**: (1) api.ts request() のステータス保持(409 判定の恒久化、
後続フェーズで)/ (2) SJIS diff 表示の文字化け(アプリ横断のエンコーディング課題、専用タスク推奨)/
(3) 選択中 worktree の削除が Windows ロックで失敗(editor-persistence 検証で発見した既存問題)

## In progress / stopping point

2026-07-21 15:57 — 新セッションで resume。委任中の subagent なし。作業ツリークリーン。
Phase 3 実装は ac27473 feat(git) としてコミット済み(チェックポイント f8e213e、grow 第 1 回 13f8a57 も完了)。
ゲート内で実施した追加修正(コミットに含む): act() catch でも状態再取得(競合失敗直後の stale 表示解消)/
競合行の個別ステージ(+)ボタン非表示(誤ステージ footgun)/ 旧マージバナー重複解消(ChangesTab)。

**注記(このブランチの混在物)**: 本ミッションと別件の一件タスク「エディター状態の永続化」が
コミット d8131be としてこのブランチに載っている(検証・レビュー済みの完結した変更)。
ミッションの未コミット変更(api.ts / DiffPane / DiffTabsPane / GitTab / styles.css の hunk-strip 分 /
types.ts / server/git.ts / server/index.ts / 新規 diffPatch・diffHunk・DiffHunkStrip)はすべて作業ツリーに残っている。
このセッションが死んでいた場合: `git status` と `npm test`(36 件)で現実を確認してから 2.V へ

## Verification status

- Verified(Phase 1 追加分): 複数行本文の API 往復と UI 表示 / --no-ff マージ(UI からも親 2 つ)/
  ffOnly の成功・拒否 / undo の staged 復帰・初回ガード / discardAll の staged 温存・未追跡削除・
  キャンセル無変更 / subdir 正規化(undo・discardAll)/ HistoryTab レース修正後の typecheck・test
- Verified(Phase 2 追加分): CRLF/SJIS のハンク stage/unstage/discard(staged バイト cmp 完全一致・
  U+FFFD なし)/ 409 時の index・worktree 無変更 / UI 全経路(表示・スクロール連動・danger 確認・
  409 自動再読込・兄弟タブ双方向自動更新)/ header 同一性ロック(再現シナリオ 409・誤爆なし・偽 409 なし)/
  vitest 36・typecheck green
- Verified(Phase 4 追加分、4.V ブラウザー E2E): リモートブランチ checkout(tracking 作成+切替)/ rename(upstream 維持)/
  force-with-lease push(キャンセル無変更・承認で bare 反映・danger 確認)/ pull --rebase(線形化・競合時 rebase バナー+中止復元)/
  リモートブランチ削除 / リモート管理 add/set-url/remove / 回帰(status・diff・履歴・vitest 48・typecheck)/ bare --force 不存在
- Verified(Phase 4 ゲート内修正・レビュー反映): PromptDialog 2 段目残留の修正(実機再確認)/ カレントブランチ rename 到達(実機)/
  rename インジェクション閉鎖(`-f`/`-M`/`-D` 等の再攻撃全拒否・reviewer 実証)/ remote 系 `--` / parseRemotesOutput(vitest 5 件)
- Verified(Phase 3 追加分): 競合 3 経路(ファイル全体 ours / theirs / ブロック毎 ours・both)→ マーカー 0 →
  解決済み(encoding 維持保存 + stage)→ continue でマージコミット生成 / abort 完全復元 /
  rebase バナー(スキップ表示)+ 中止復元 / operation API スモーク(GIT_EDITOR 抑止・merge+skip 400)/
  resolve-side スモーク / 失敗時の即時状態反映 / 回帰(diff タブ・ハンク帯・解決済みボタン無効条件)
- Unverified: なし(Phase 0–3 範囲)

## Blockers / notes

- None
- 持ち越し FYI(1.R): マージ中の undo/discard ボタン無効化(git 自身が fail-safe 拒否するため実害なし、
  Phase 3 の operation 移行で織り込む)/ merge 系の `--` セパレーター統一(責務外、任意)
- 持ち越し FYI(0.R): danger ボタン autoFocus / useConfirm resolver / vitest include に .test.tsx(client テスト追加時)
- 残存 native confirm 一覧は journal 参照(GitTab 切替/削除、Sidebar、WorktreeView 等 — 後続フェーズで段階置換)
