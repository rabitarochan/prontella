# Current state: git-client-parity

> **This file is the single source of truth.** Any session may die at any moment.
> Update it after every task completion and every checkpoint.
> If this file and reality (code, test results) disagree, reality is the truth. Record it in the journal and fix this file.

- slug: `git-client-parity`
- Phase: Phase 1 完了(ゲート通過)→ Phase 2 — ハンク単位ステージ(中核・高リスク)
- Progress: 8 / 30 実装タスク完了(Phase 0: 0.1〜0.4 ✅ / Phase 1: 1.1〜1.4 ✅。すべて verifier 検証 + reviewer LGTM 済み)
- Last updated: 2026-07-20 23:25
- Updated by: Conductor session (fable)

## Next move (most important)

**/loop はフェーズ境界(Phase 1 ゲート通過)で停止。ユーザーの再開指示待ち。** 再開時は Phase 2 へ:

1. **2.1(builder、単独委任)**: 純関数モジュール(置き場所は `server/diffPatch.ts` など新ファイル推奨)
   `splitDiffHunks(diffText)` と `buildPartialPatch(header, hunks, selected)` を実装 + vitest。
   **latin1 バイト保存**前提、`\r` と `\ No newline at end of file` を保持。テストケースに
   CRLF / 末尾改行なし / 複数ハンク / 非 ASCII バイトを必ず含める(plan.md の R1/R2/R3 の主戦場)
2. **2.2(builder、2.1 完了後)**: `POST /api/git/apply-hunks {dir,path,scope,hunks[],expectedHunkCount}`。
   サーバーで権威 diff を Buffer 再生成(git diff [--cached] -- path)→ ハンク数照合(不一致 409)→
   patch 組立 → runGitInput で `git apply --cached` / `--cached --reverse` / `--reverse`
3. **2.3(builder)**: DiffPane/DiffTabsPane にハンク表示 + ハンク毎 stage/unstage/discard ボタン
4. ゲート: vitest 全グリーン + verifier が **CRLF と Shift_JIS ファイル**で実測 + reviewer(パッチ正確性重点)
5. 2.4(行単位選択)はゲート外。Phase 2 ゲート後に回してよい

## In progress / stopping point

**ループ停止時の申し送り(2026-07-20 23:25)**:
- 停止理由: Phase 1 ゲート通過(フェーズ境界 = 無人ループの設計上の停止点)
- 進捗: Phase 0–1 完了・コミット済み(ブランチ feat/git-client-parity)。全機能 verifier 実測 +
  Conductor ブラウザー検証 + reviewer LGTM(Phase 0: rec 1 件修正済み / Phase 1: rec 1 件修正済み)
- 再開方法: `/fable-team:work`(1 サイクル)または `/loop /fable-team:work`(次のフェーズ境界まで自動)

## Verification status

- Verified(Phase 1 追加分): 複数行本文の API 往復と UI 表示 / --no-ff マージ(UI からも親 2 つ)/
  ffOnly の成功・拒否 / undo の staged 復帰・初回ガード / discardAll の staged 温存・未追跡削除・
  キャンセル無変更 / subdir 正規化(undo・discardAll)/ HistoryTab レース修正後の typecheck・test
- Unverified: なし(Phase 0–1 範囲)

## Blockers / notes

- None
- 持ち越し FYI(1.R): マージ中の undo/discard ボタン無効化(git 自身が fail-safe 拒否するため実害なし、
  Phase 3 の operation 移行で織り込む)/ merge 系の `--` セパレーター統一(責務外、任意)
- 持ち越し FYI(0.R): danger ボタン autoFocus / useConfirm resolver / vitest include に .test.tsx(client テスト追加時)
- 残存 native confirm 一覧は journal 参照(GitTab 切替/削除、Sidebar、WorktreeView 等 — 後続フェーズで段階置換)
