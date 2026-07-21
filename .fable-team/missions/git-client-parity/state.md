# Current state: git-client-parity

> **This file is the single source of truth.** Any session may die at any moment.
> Update it after every task completion and every checkpoint.
> If this file and reality (code, test results) disagree, reality is the truth. Record it in the journal and fix this file.

- slug: `git-client-parity`
- Phase: **Phase 3 完了(ゲート通過)** → 次はユーザー判断(Phase 4 リモート/ブランチ操作 or 2.4 行単位選択)
- Progress: 15 / 30 実装タスク完了(Phase 0: 4 ✅ / Phase 1: 4 ✅ / Phase 2: 2.1〜2.3 ✅ / Phase 3: 3.1・3.2・3.3a・3.3b ✅ すべてゲート込み。未着手: 2.4(P1)と Phase 4 以降)
- Last updated: 2026-07-21 15:40(Phase 3 ゲート通過のチェックポイント)
- Updated by: Conductor session (fable)

## Next move (most important)

**Phase 3 完了(3.V 9 項目 E2E ✅ + 3.R LGTM、ゲート内修正 3 件込み)。フェーズ境界で停止 — ユーザー選択待ち:**

1. **選択肢 A(推奨)**: Phase 4 — リモート/ブランチ操作(P0 残り + P1。plan.md L137〜。4.1/4.2/4.5 は並列可)
2. **選択肢 B**: 2.4 — 行単位選択(P1 精緻化)
3. コミット提案中(Phase 2 と同じ feat(git) + chore(fable-team) の 2 コミット構成)。ユーザー承認後に実施
4. **次フェーズは新セッション推奨**(本セッションのコンテキストが長大)— `/fable-team:resume-mission` で再開
5. テスト現状: vitest 48 件(diffPatch 15 / diffHunk 6 / editorState 15 / conflictBlocks 12)+ typecheck green

**持ち越し債務(非ブロッカー、記録済み)**: merge 競合の 500 レスポンス(git エラー構造化時に回収)/
409 判定の文字列一致(request() のステータス保持で恒久化)/ SJIS diff 表示の文字化け(アプリ横断)/
マーカーベース解析の原理的限界(列 0 の正当 `=======` で誤認し得る。非サイレント・代替経路あり)/
競合行の discard ボタン(pre-existing)/ 選択中 worktree 削除の Windows ロック失敗

**持ち越し債務(いずれも記録済み・非ブロッカー)**: (1) api.ts request() のステータス保持(409 判定の恒久化、
後続フェーズで)/ (2) SJIS diff 表示の文字化け(アプリ横断のエンコーディング課題、専用タスク推奨)/
(3) 選択中 worktree の削除が Windows ロックで失敗(editor-persistence 検証で発見した既存問題)

## In progress / stopping point

2026-07-21 15:40 — Phase 3 ゲート通過でチェックポイント。委任中の subagent なし。
ゲート内で実施した追加修正: act() catch でも状態再取得(競合失敗直後の stale 表示解消)/
競合行の個別ステージ(+)ボタン非表示(誤ステージ footgun)/ 旧マージバナー重複解消(ChangesTab)。
コミットは未実施(ユーザーへ提案中。Phase 3 実装一式 = 作業ツリーの未コミット変更全部 +
新規 conflictBlocks.ts / conflictBlocks.test.ts / ConflictResolvePane.tsx)。

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
