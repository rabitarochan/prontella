# Current state: git-client-parity

> **This file is the single source of truth.** Any session may die at any moment.
> Update it after every task completion and every checkpoint.
> If this file and reality (code, test results) disagree, reality is the truth. Record it in the journal and fix this file.

- slug: `git-client-parity`
- Phase: **Phase 5 完了(ゲート通過)** → 次はユーザー判断(Phase 6 タグ/スタッシュ差分/ファイル履歴/検索 or 積み残しの 2.4 行単位選択)
- Progress: 24 / 30 実装タスク完了(Phase 0〜5: すべてゲート込み ✅。未着手: 2.4(P1)と Phase 6)
- Last updated: 2026-07-21 19:52(Phase 5 ゲートクローズ、コミット/次フェーズはユーザー判断待ち)
- Updated by: Conductor session (fable)

## Next move (most important)

**Phase 5 完了・コミット確定(f901755)。ユーザー選択で次フェーズは Phase 6(タグ/スタッシュ差分/ファイル履歴/検索)。
新セッションで `/fable-team:resume-mission` から Phase 6 開始。**

1. **次の一手: Phase 6 開始**(6.1 タグ一覧/作成/削除/push / 6.2 stash 差分閲覧 / 6.3 ファイル履歴+過去版 diff / 6.4 履歴検索(grep/author/path)/ 6.5 blame 任意。plan.md L168〜。**6.1〜6.5 は相互独立=並列可**だが、同一ファイル群(server/git.ts・index.ts・api.ts・types.ts・GitTab.tsx・HistoryTab.tsx)を触るなら Phase 3/4/5 同様の順次継続が安全)
2. コミット済み: f901755 feat(git) Phase 5 一式(6 files, +335/-6)。誤生成ファイル `e.textContent)` はユーザー承認で削除済み。この後 chore(fable-team) チェックポイントを追加予定 → 作業ツリークリーンへ
3. 2.4(行単位ステージ、P1)は引き続き未着手として残存
4. テスト現状: vitest 53 件(diffPatch 15 / diffHunk 6 / editorState 15 / conflictBlocks 12 / parseRemotesOutput 5)+ typecheck green
5. Phase 5 で再利用可能な資産: HistoryTab のコミット ContextMenu(operation/busy 連動 disabled)/ 新規ルートの hash・引数検証パターン(先頭 `-` 拒否)/ ConfirmDialog の danger + 影響件数明示
2. 5.1 実装形: `resetToCommit` + `POST /api/git/reset`(hash `/^[0-9a-f]{4,40}$/i` + mode ホワイトリストで 400。`git reset` に `--` は不使用 — パス形式に解釈が変わるため)/ HistoryTab コミット行 ContextMenu + ConfirmDialog(hard のみ danger、未コミット変更 N 件警告は GitTab の dirty prop)/ GitTab の act をそのまま onAct prop 渡し(再マウントでメッセージが消えない)
3. Phase 5 実装は作業ツリーに未コミットで蓄積 → フェーズゲート後にコミット提案(Phase 4 と同様)
4. テスト現状: vitest 53 件 + typecheck green(5.1 受入時点)
5. 2.4(行単位選択)は引き続き未着手の P1 として残存

**持ち越し債務(Phase 5 追加分、非ブロッカー)**: hard reset 警告の件数が部分ステージ(同一ファイルが staged/unstaged 両方)を
2 重計上し得る(表示 nuance、操作は git が正しく処理)/ dirty・untracked・operation は 10 秒ポーリング由来で直近変更の反映窓あり /
新規 4 ルートの検証ロジック(hash 正規表現・mode ホワイトリスト・onto ガード)にユニットテスト無し(既存 operation 系ルートと同じ E2E 依存 = 慣習一致、回帰ではない)。
※ merge の branch 素通しは 5.R 反映で解消済み(先頭 `-` ガード追加)/ `git rebase --` セパレーターは Phase 4 と揃える余地あり(FYI、必須でない)

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

2026-07-21 18:30 — Phase 5 進行中。builder 1 体(5.1 実装済み)に 5.2(cherry-pick)を継続委任中。
Phase 5 の変更は未コミット(server/git.ts / server/index.ts / client/src/api.ts / types.ts /
HistoryTab.tsx / GitTab.tsx)。
このセッションが死んでいた場合: `git status` と `npm run test`(53 件)で現実を確認 → journal 末尾から再開

## Verification status

- Verified(Phase 5 追加分、5.V ブラウザー E2E): reset soft/mixed(staged/unstaged 区別、git 突合)/ hard(danger・警告・
  キャンセル無変更・承認でクリーン)/ cherry-pick クリーン+競合→Phase 3 UI 解決→continue 完走 / revert クリーン+
  競合→abort 完全復元 / rebase 線形化・カレント disabled・競合→中止復元 / operation 中の履歴メニュー disabled(R7)/
  回帰(status・diff・コミット・履歴、typecheck・vitest 53)。未検証: なし(ゲート内修正の実機再確認は進行中)
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
