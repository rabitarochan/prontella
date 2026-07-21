# Current state: git-client-parity

> **This file is the single source of truth.** Any session may die at any moment.
> Update it after every task completion and every checkpoint.
> If this file and reality (code, test results) disagree, reality is the truth. Record it in the journal and fix this file.

- slug: `git-client-parity`
- Phase: **Phase 2 完了(ゲート通過)** → 次はユーザー判断(2.4 行単位選択 or Phase 3 コンフリクト解決)
- Progress: 11 / 30 実装タスク完了(Phase 0: 0.1〜0.4 ✅ / Phase 1: 1.1〜1.4 ✅ / Phase 2: 2.1〜2.3 ✅ + ゲート 2.V/2.R ✅。2.4(行単位、P1)はゲート外で未着手)
- Last updated: 2026-07-21 14:29(Phase 2 ゲート通過のチェックポイント)
- Updated by: Conductor session (fable)

## Next move (most important)

**Phase 2 はゲート通過済み。フェーズ境界で停止中 — ユーザーの選択待ち:**

1. **選択肢 A(推奨)**: Phase 3 — コンフリクト解決(P0。ours/theirs/手動の 3 経路 + continue/abort。plan.md L122〜)
2. **選択肢 B**: 2.4 — 行単位選択(P1 精緻化。buildPartialPatch のヘッダー recount + 行チェック UI)
3. 再開時はどちらもいつもの委任ループ(builder → verifier → reviewer)で

**持ち越し債務(いずれも記録済み・非ブロッカー)**: (1) api.ts request() のステータス保持(409 判定の恒久化、
後続フェーズで)/ (2) SJIS diff 表示の文字化け(アプリ横断のエンコーディング課題、専用タスク推奨)/
(3) 選択中 worktree の削除が Windows ロックで失敗(editor-persistence 検証で発見した既存問題)

## In progress / stopping point

2026-07-21 14:29 — Phase 2 ゲート通過でチェックポイント。委任中の subagent なし。
ゲート内で実施した追加修正: 兄弟タブ自動更新(2.3 attempt 2)/ apply-hunks の header 同一性ロック
(2.R rec#1。expectedHeaders 追加 — server/index.ts・api.ts・DiffHunkStrip.tsx)。
コミットは未実施(ユーザーへ提案中。Phase 2 実装一式 = 作業ツリーの未コミット変更全部 + 新規 4 ファイル)。

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
- Unverified: なし(Phase 0–2 範囲)

## Blockers / notes

- None
- 持ち越し FYI(1.R): マージ中の undo/discard ボタン無効化(git 自身が fail-safe 拒否するため実害なし、
  Phase 3 の operation 移行で織り込む)/ merge 系の `--` セパレーター統一(責務外、任意)
- 持ち越し FYI(0.R): danger ボタン autoFocus / useConfirm resolver / vitest include に .test.tsx(client テスト追加時)
- 残存 native confirm 一覧は journal 参照(GitTab 切替/削除、Sidebar、WorktreeView 等 — 後続フェーズで段階置換)
