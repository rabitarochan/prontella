# Current state: git-client-parity

> **This file is the single source of truth.** Any session may die at any moment.
> Update it after every task completion and every checkpoint.
> If this file and reality (code, test results) disagree, reality is the truth. Record it in the journal and fix this file.

- slug: `git-client-parity`
- Phase: **Phase 6 完了(ゲート通過: 6.V 全基準 ✅ + 6.R LGTM)** → 次はユーザー判断(コミット承認 / 2.4 or 6.5 or 完了判定)
- Progress: 28 / 30 実装タスク完了(Phase 0〜6 すべてゲート込み ✅。残: 2.4(P1、DoD 唯一の残項目)と 6.5(任意・DoD 外))
- Last updated: 2026-07-22 03:20(Phase 6 ゲートクローズ、コミット/次フェーズはユーザー判断待ち)
- Updated by: Conductor session (fable)

## Next move (most important)

**Phase 6 完了(6.V 全基準 ✅ / 6.R LGTM・must-fix 0・recommended 0・FYI 5・修正サイクル 0)。ユーザー判断待ち:
(A) コミット承認 — feat(git) Phase 6 一式 + chore(fable-team) チェックポイントの 2 コミット構成(Phase 4/5 と同様)
(B) 次の一手 — 2.4 行単位ステージ(DoD 唯一の残項目・P1)/ 6.5 blame(任意・DoD 外)/ ミッション完了判定(2.4 をスコープ外とする場合)
(C) growth inbox 5 件 → /fable-team:grow 実施可否。新セッション再開時は /fable-team:resume-mission。**

1. Phase 6 成果: タグ管理(一覧/作成/削除/push)/ stash 差分閲覧 / ファイル履歴(リネーム横断 origPath)/ 履歴検索(author・grep・path、--fixed-strings)。6.V は CDP 直叩き実機 E2E で全 5 基準合格、6.R は攻撃全不成立を実証して LGTM
2. 6.5(blame)は任意・DoD 外 — ユーザー判断待ち
3. Phase 6 実装は作業ツリーに未コミット(コミット提案中。`.fable-team/` の記録更新も同様)
4. テスト現状: vitest 63 件(diffPatch 15 / diffHunk 6 / editorState 15 / conflictBlocks 12 / parseRemotesOutput 5 / stashDiffText 5 / parseFollowLog 5)+ typecheck green(6.R が実走で再確認済み)
5. 2.4(行単位ステージ、P1)が DoD の唯一の残項目

**持ち越し債務(Phase 6 追加分、非ブロッカー、6.R 全て FYI)**: classifyDiffLine が `--- foo` 型の内容行をヘッダー誤色(表示のみ、コード内コメント明示済み)/ stash 差分タブは開いた後に当該 stash を drop すると旧内容のスナップショット表示(読み取り専用・実害なし)/ FileHistoryModal・stash 差分タブに Escape クローズ無し(Confirm/PromptDialog と非対称)/ 既存 stash・remote 行ボタンの disabled は busy のみ(新タグ行は busy||operation — 既存側の非対称残置)/ stash-apply/drop の検証位置は git.ts 内+500(新規ルートはルート内+400)の非対称 / フィルタ変更で selected 自動クリアなし(ハイライト消えのみ)/ Monaco "TextModel got disposed" の到達経路が FileHistoryModal で増加(Phase 1/2 債務そのもの、6.V 切り分け済み)/ ファイル履歴一覧にマージコミット不表示(--follow --name-status の仕様、明示的制限)

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

2026-07-22 03:20 — Phase 6 ゲートクローズ。ユーザー判断待ち(コミット承認 / 次の一手 / grow)。
Phase 6 の変更は未コミット(server/git.ts / git.test.ts / index.ts / api.ts / types.ts / GitTab.tsx /
DiffTabsPane.tsx / FileTree.tsx / FilesTab.tsx / styles.css + 新規 StashDiffPane.tsx / stashDiffText.ts /
stashDiffText.test.ts / FileHistoryModal.tsx)。
このセッションが死んでいた場合: `git status` と `npm run test`(63 件)で現実を確認 → journal 末尾から再開

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
- Verified(Phase 6 追加分、6.V ブラウザー E2E = CDP 直叩き): タグ(軽量/注釈作成の cat-file 型突合・push 後の型維持・ローカル/リモート削除の danger+キャンセル無変更・作成 2 段キャンセル)/ stash 差分タブ(`stash show -p` とバイト完全一致・apply/drop の stopPropagation・タブ開閉/切替)/ ファイル履歴(リネーム横断 origPath の正しい diff — origPath 無しだと誤表示になる反例も実証・モーダル開閉)/ 履歴検索(author/grep/path の件数・hash 突合・`[WIP]` メタ文字 500 なし・フィルタ中レーン退避・不正 path でもツールバー操作可・フィルタ中の選択/メニュー正常)/ 回帰(status・ステージ・コミット・diff・stash 操作・vitest 63・typecheck)
- Unverified(Phase 6): tag push/delete の busy 瞬間 disabled 表示(処理が数十 ms で完了し観測不能 — コード確認のみ、6.R の対称性チェック対象)
- Unverified: なし(Phase 0–3 範囲)

## Blockers / notes

- None
- 持ち越し FYI(1.R): マージ中の undo/discard ボタン無効化(git 自身が fail-safe 拒否するため実害なし、
  Phase 3 の operation 移行で織り込む)/ merge 系の `--` セパレーター統一(責務外、任意)
- 持ち越し FYI(0.R): danger ボタン autoFocus / useConfirm resolver / vitest include に .test.tsx(client テスト追加時)
- 残存 native confirm 一覧は journal 参照(GitTab 切替/削除、Sidebar、WorktreeView 等 — 後続フェーズで段階置換)
