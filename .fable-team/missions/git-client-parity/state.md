# Current state: git-client-parity

> **This file is the single source of truth.** Any session may die at any moment.
> Update it after every task completion and every checkpoint.
> If this file and reality (code, test results) disagree, reality is the truth. Record it in the journal and fix this file.

- slug: `git-client-parity`
- Phase: Phase 0 完了(ゲート通過)→ Phase 1 — コミット/マージ運用の必須(P0)
- Progress: 4 / 30 実装タスク完了(Phase 0: 0.1〜0.4 すべて ✅ verifier 検証・reviewer LGTM 済み)
- Last updated: 2026-07-20 22:50
- Updated by: Conductor session (fable)

## Next move (most important)

**ユーザーへの Phase 0 中間報告を提示済み(フェーズ境界の設計上の停止点)。** 再開時:

1. 未コミットなら、まず Phase 0 の成果をコミット(ユーザー承認前提。Conventional Commits。
   例: `feat(git): Git 操作基盤を追加 (runGitInput / operation 検知 / ConfirmDialog / vitest)`)
2. Phase 1 のタスク 1.1〜1.4 を builder に**並列**委任(plan.md の Phase 1 表参照。相互独立):
   - 1.1 複数行コミット本文: ChangesTab の textarea は既に複数行入力可か確認 → commit API は
     message をそのまま -m 渡し(現状 OK)。HistoryTab のコミット詳細に body 表示(%b)を追加
   - 1.2 merge opts { noFf, ffOnly, message }: server/git.ts merge()(git.ts:511-513)拡張 →
     index.ts → api.ts → GitTab のブランチメニュー「マージ」を --no-ff 既定に(UI で ff-only も選択可に)
   - 1.3 undo last commit: reset --soft HEAD~1。ChangesTab か履歴に UI + useConfirm(normal)
   - 1.4 discard all / 全未追跡削除: useConfirm(danger、対象ファイル数明示)。キャンセル経路必須
   - 各 brief に検証ハーネス(mission.md)+ 3 層パターン + gitMode 正規化 + 型同期の制約を含める
3. 完了後 1.V(verifier)→ 1.R(reviewer)のゲート

## In progress / stopping point

None(Phase 0 はすべて記録済み・受入済み。Phase 1 は未着手)

## Verification status

- Verified(0.V + reviewer + Conductor 実測):
  - runGitInput: パッチ実適用(staged/unstaged 併存)、timeout kill、64MB 上限ガード発火
  - getOperationState: null→merge→null(API 経由)、rebase>merge 優先、subdir/非 git で null
  - ConfirmDialog: 表示・Escape/バックドロップキャンセル・破棄確定の全経路(ブラウザー実測)
  - vitest: test 3/3、build に test 非混入、typecheck 非干渉
- Unverified: なし(Phase 0 範囲)

## Blockers / notes

- Phase 0 の変更は**未コミット**(コミットはユーザー承認後)
- 持ち越し FYI(reviewer): danger ボタン autoFocus / useConfirm resolver / vitest include に .test.tsx 追加(client テスト追加時)/ merging・operation の二重計算と意味差(Phase 3 の operation 移行で整理)
- 残存 native confirm 14 箇所一覧は builder B レポート・journal 参照(Phase 1 の 1.4 や後続で段階置換)
