# Execution plan: git-client-parity

> Author: architect / Approved: 2026-07-20(ユーザー承認: Phase 0–6 全部を完了ライン、除外提案採用)
> ステータス凡例: ⬜ 未着手 / 🔄 進行中 / ✅ 完了(verifier 検証済み) / ⏸️ ブロック
> サイズ凡例: S=1 委任で完了 / M=数回の委任 or 1 修正サイクル / L=要分割(計画時 L は警告)

## Assumptions(前提)

1 つでも崩れたら architect に再計画を依頼すること。

- **git 2.23+** がユーザー環境にある(`switch`/`restore`/`--track` の DWIM を利用)
- **単一ユーザーのローカル運用**。他クライアントとの同時編集競合は考慮外。破壊的操作の承認は都度の対話で足りる
- **認証は既存の資格情報ヘルパーで解決済み**。`runGit` は `GIT_TERMINAL_PROMPT=0` で走るため、本ミッションでクレデンシャル入力 UI は作らない(範囲外)。push/pull がクレデンシャル要求で失敗した場合はエラー表示に留める
- 全新規機能は既存の **3 層(`server/git.ts` → `server/index.ts` → `client/src/api.ts`)** と **gitMode 正規化(`bodyDir`/`requireKnownDir` による git-root 正規化、path は root 相対 forward-slash)** を必ず踏襲する
- 型は共有機構がないため `client/src/types.ts` と server 側を**同一タスク内で手動同期**する(既存の注記コメント方式を踏襲)
- **P2(対話的 rebase 等)は本ミッションのゴール外**。「外部クライアント不要」を満たすのに不要なため別ミッションへ切り出す

## ギャップ一覧(洗い出しの完成)

SourceTree / GitKraken の主要機能と現状実装の突き合わせ結果。

### P0 — 日常必須(これが無いと外部クライアントを開かざるを得ない)

| # | 不足機能 | 現状 | 備考 |
|---|---|---|---|
| P0-1 | ハンク/行単位の部分ステージ | ファイル単位のみ | SourceTree 中核。本ミッションの発火点 |
| P0-2 | マージコンフリクト解決 UI | バナー + abort のみ | 競合が出た瞬間に外部ツール依存 |
| P0-3 | `--no-ff` マージ + マージメッセージ | `merge --no-edit` 固定 | **ユーザーは常に --no-ff**。明確なギャップ |
| P0-4 | 複数行コミット本文の入力/表示 | subject のみ表示 | **Conventional Commits の body/footer** 運用に必須 |
| P0-5 | 直前コミットの取り消し(reset --soft HEAD~1) | 無し | 日常的な undo |
| P0-6 | 全変更の破棄 / 全未追跡削除 | ファイル単位 discard のみ | 破壊的 → 確認 UI と対で |
| P0-7 | リモートブランチ→ローカル追跡ブランチ作成(チェックアウト) | リモートは表示のみ | 他人のブランチで作業開始に必須 |

### P1 — これが揃うと「外部クライアント不要」が完成する

| # | 不足機能 | 備考 |
|---|---|---|
| P1-1 | reset(soft/mixed/hard)を任意コミットへ | hard は破壊的 |
| P1-2 | rebase(通常)+ continue/abort/skip | 競合は P0-2 の UI に載せる |
| P1-3 | cherry-pick + continue/abort | 同上 |
| P1-4 | revert + continue/abort | 同上 |
| P1-5 | force push(**--force-with-lease**)、pull --rebase、set-upstream | force は常に with-lease |
| P1-6 | リモートブランチ削除 | 破壊的 |
| P1-7 | ブランチ rename | |
| P1-8 | リモート管理(remote add/remove/set-url + 一覧) | |
| P1-9 | タグ(作成[軽量/注釈]・削除・push) | 表示は `%D`/RefChips で既存 |
| P1-10 | スタッシュ内容の diff 閲覧 | `stash show -p` |
| P1-11 | ファイル履歴(per-file log)+ 過去バージョン閲覧 | |
| P1-12 | 履歴検索/フィルタ(message/author/path) | |
| P1-13 | 行単位ステージ(P0-1 の精緻化) | ハンク recount が必要 |
| P1-14 | blame(任意) | P1 下位。Phase 6 optional |

### P2 — 高度・任意(本ミッション範囲外、別ミッション候補)

対話的 rebase(並べ替え/squash/fixup/edit)、reflog 閲覧・復元、graph の高度フィルタ、
worktree を任意コミット/detached から作成、format-patch/am、bisect、blame ヒートマップ。
→ いずれも「外部クライアントを全く使わず日常作業が完結する」ゴールには不要。ターミナルタブが常に利用可能な点も踏まえ、明示的に後回し。

### 除外(ユーザー承認済み)

| 除外機能 | 理由 |
|---|---|
| submodule | 利用の申告なし・複雑度が高い。必要時はターミナルで対応可能 |
| GPG/SSH コミット署名 | 鍵管理・Windows agent 依存が重い。git config + ターミナルの方が堅実 |
| Git LFS | インフラ固有。汎用 Git クライアント parity の範囲外 |
| bisect | 稀。ワークフローが重くターミナルで十分 |
| クレデンシャル入力 UI | セキュリティ面。資格情報ヘルパー前提とし範囲外(Assumptions に明記) |
| 対話的 rebase フルエディタ | P2。表面積が巨大でリスク大。別ミッションへ |

## Key design decisions(主要な設計判断)

| # | 判断事項 | 採用案 | 根拠 | 却下した代替案(と却下理由) | 覆す条件(reconsider if) |
|---|---|---|---|---|---|
| (a) | **ハンク/行ステージの実現方式** | サーバーで **git 自身の diff を再生成**(`git diff [--cached] -- path`)→ ハンクを**インデックス指定でフィルタ**して patch を組み立て → `git apply --cached`(stage)/ `--cached --reverse`(unstage)/ `--reverse`(discard)。クライアントは**選択したハンク番号のみ送信**、patch 本体は送らない | git のフォーマットを往復させ、CRLF・encoding・rename 判定を git に委譲。権威ある diff を毎回サーバーで再生成するので陳腐化・改竄を排除。バイト保存は latin1 文字列経由で `\r`/`\ No newline` を維持 | ① Monaco の original/modified から patch 自作 → diff アルゴリズム差でハンクが Monaco 表示と一致せず、CRLF/encoding を再実装する羽目に。② client が patch 丸ごと POST → 陳腐化・改竄・非UTF8 バイト化けのリスク | git diff のハンク境界と Monaco 表示がズレてユーザーが「どのハンクを操作したか」を誤認 → ハンクを git 由来のカスタム表示に寄せ、Monaco オーバーレイをやめる |
| (b) | **コンフリクト解決 UI の方式** | マーカー付きファイルを**書き込み可能 Monaco で編集** + 競合ブロック毎に **ours/theirs/both** アクション + 残マーカーカウンタ + 「解決済み(git add)」。continue/abort/skip は operation 汎用化(判断 e)で共通化 | 既存が Monaco 中心・readOnly diff。段階的に書き込み対応へ拡張するのが自然。SourceTree すら競合は外部 mergetool を起動する現実 | 完全 3-way マージエディタ → `monaco-editor` コアに 3-way ウィジェットは同梱されず、自作は高コスト・高リスク。parity には過剰 | 保守された 3-way マージウィジェットを採用可能になったら解決サーフェスを格上げ |
| (c) | **破壊的操作の確認 UI 統一** | 再利用 `ConfirmDialog` + `useConfirm()`(既存 modal パターン準拠、severity: normal/danger)。**force push は常に `--force-with-lease`**、danger モーダルは赤ボタン + **影響範囲(ファイル/行数)明示** | native `confirm()` が各所に散在し不統一・テスト不能・誤爆しやすい。承認は都度(過去承認は繰り越さない) | 各所 native confirm 継続 → 不統一で破壊操作の重大度差を表現できない | MVP 縮小方針を採る場合、最低限 `--force-with-lease` 化と影響文言だけ先行し、モーダル化は後続に |
| (d) | **テストハーネス導入の是非/範囲** | **vitest を純ロジックに限定導入**(porcelain パーサ・パッチ splitter・競合パーサ・rev バリデーション)。`npm run test` を追加。DOM/コンポーネント・git 統合 e2e は範囲外 | パッチ生成は**バグがサイレント=データ損失**に直結する最高リスク領域。純関数なら安価かつ高速に de-risk できる | ① 導入せず dev 手動検証のみ → パッチ不具合を見逃す。② フル e2e/DOM テスト → コスト過大でミッションの主眼外 | パッチ生成が完全に `git apply` へ委譲でき非自明な純ロジックが消えるなら、パーサ最小テストのみに縮小 |
| (e) | **進行中オペレーション状態の一般化** | `GET /api/git/status` の `merging` を `operation: 'merge'\|'rebase'\|'cherry-pick'\|'revert'\|null` に一般化(`.git` 内 `MERGE_HEAD`/`REBASE_HEAD`(`rebase-merge/`,`rebase-apply/`)/`CHERRY_PICK_HEAD`/`REVERT_HEAD` で判定) | 競合・continue/abort/skip を merge/rebase/cherry-pick/revert で共通化でき、Phase 3 の UI を各操作で使い回せる | 機能ごとに個別バナー/個別 API → 重複と挙動の不整合 | (基盤なので原則覆さない) |

## Phase 0: 基盤(enablers)

**Gate**: `npm run typecheck` グリーン / `npm run test` グリーン(最小 1 本)/ dev 起動で `ConfirmDialog` 表示と `operation` 検出が動作 / reviewer が API 契約・型同期をレビュー。
**並列**: 0.1〜0.4 は相互に独立 = **すべて並列可**。

| # | タスク | 担当 | サイズ | 観測可能な完了基準 | 依存 | 状態 |
|---|---|---|---|---|---|---|
| 0.1 | `runGit` の stdin(Buffer)対応版 `runGitInput(cwd, args, input: Buffer)` を追加(spawn ベース、shell 無効・windowsHide、stdout/stderr を Buffer で受ける)。既存 `runGit` は不変 | builder | S | dev で `git apply --cached` に patch Buffer を渡して往復が成立(最小手動確認)+ typecheck 通過 | - | ✅ |
| 0.2 | `getOperationState(dir)` を `git.ts` に追加。`GET /api/git/status` の `merging` を `operation` に一般化(後方互換のため `merging` は当面残置可) | builder | S | マージ中に status が `operation:'merge'`、通常時 `null` を返す(dev) | - | ✅ |
| 0.3 | 再利用 `ConfirmDialog` + `useConfirm()` フック(`modal-backdrop`/`modal` パターン準拠、severity normal/danger、danger は赤ボタン)。既存の discard 確認を新ダイアログに置換 | builder | M | 既存 discard が新モーダル経由で動作(dev)、native `confirm` を 1 箇所以上撤去 | - | ✅ |
| 0.4 | vitest 導入。`npm run test` を追加し、`git.ts` の porcelain パーサ 1 つに最小テストを 1 本 | builder | S | `npm run test` グリーン、`npm run typecheck`/`build` 不変 | - | ✅ |
| 0.V | 上記を dev で動作確認 | verifier | S | operation 検出・ConfirmDialog・runGitInput 往復を実操作で確認 | 0.1-0.4 | ✅ |
| 0.R | 基盤レビュー(型同期・API 契約・spawn の Windows 安全性) | reviewer | S | 指摘 0 または修正反映 | 0.V | ✅ |

## Phase 1: コミット/マージ運用の必須(P0、低リスク・高頻度)

**Gate**: 複数行 Conventional Commit の作成→履歴で本文表示 / `--no-ff` マージで親 2 つのマージコミットが graph に出る / undo-last-commit で変更がステージ済みに戻る / discard-all が danger モーダル経由で作業ツリーをクリアする — すべて verifier が dev で検証 + reviewer レビュー(特に 1.4 の破壊範囲)。

| # | タスク | 担当 | サイズ | 観測可能な完了基準 | 依存 | 状態 |
|---|---|---|---|---|---|---|
| 1.1 | コミット本文(複数行)対応。`message` をそのまま `-m` 渡し(複数行 OK)、履歴の commit-side に subject 以外の本文を表示(`git show`/`%b` 由来) | builder | S | subject+空行+body のコミットを作成→ HistoryTab の詳細に本文が表示 | - | ✅ |
| 1.2 | `merge` に `opts:{ noFf?; ffOnly?; message? }`。API/型同期。ブランチ context メニューの「マージ」を **--no-ff 既定** に | builder | M | --no-ff マージ→ graph に親 2 つのマージコミット。ff-only も選択可 | - | ✅ |
| 1.3 | 直前コミットの取り消し(`reset --soft HEAD~1`)。ボタン + `useConfirm`(normal) | builder | S | 実行後 HEAD が 1 つ戻り、直前コミットの変更がステージ済みに戻る | 0.3 | ✅ |
| 1.4 | 全変更破棄 / 全未追跡削除。tracked=`git restore`、untracked=選択で削除。`useConfirm`(danger、影響ファイル/行数明示) | builder | M | danger モーダル→ tracked 変更が消え、選択に応じ未追跡も削除。キャンセルで無変更 | 0.3 | ✅ |
| 1.V | Phase 1 動作検証 | verifier | S | 上記 4 つを dev で実操作検証、1.4 の破壊範囲を重点確認 | 1.1-1.4 | ✅ |
| 1.R | レビュー | reviewer | S | 指摘反映(最大 2 サイクル) | 1.V | ✅ |

## Phase 2: ハンク単位ステージ(P0、中核・高リスク)

**Gate**: `splitDiffHunks`/`buildPartialPatch` の vitest が全グリーン(CRLF・末尾改行なし・複数ハンク・非ASCII バイトを含む)/ dev で **CRLF ファイルと Shift_JIS 日本語ファイル**のハンク stage/unstage/discard を verifier 検証(status と staged 側 diff の**実内容**を確認)/ reviewer レビュー(パッチ生成の正確性を重点)。

| # | タスク | 担当 | サイズ | 観測可能な完了基準 | 依存 | 状態 |
|---|---|---|---|---|---|---|
| 2.1 | 純関数モジュール: `splitDiffHunks(diffText)` と `buildPartialPatch(header, hunks, selected)`。**latin1 バイト保存**前提、`\r` と `\ No newline at end of file` を保持。vitest で CRLF/末尾改行なし/複数ハンク/非ASCII を網羅 | builder | M | 該当 vitest ケースが全グリーン | 0.4 | ✅ |
| 2.2 | `POST /api/git/apply-hunks {dir,path,scope:'stage'\|'unstage'\|'discard',hunks:number[],expectedHunkCount}`。サーバーで権威 diff を**Buffer で再生成**→ ハンク数照合(不一致は 409 で再読込指示)→ patch 組立 → `git apply --cached`/`--cached --reverse`/`--reverse`(`runGitInput`) | builder | M | 2 ハンクのファイルで 1 ハンクだけ stage → status がそのファイルを staged と unstaged **両方**に出す | 0.1, 2.1 | ✅ |
| 2.3 | フロント: DiffPane/DiffTabsPane にハンク表示 + ハンク毎の stage/unstage/discard 操作(**git 由来の parsed hunks で駆動**) | builder | M | dev で各ハンクにボタンが出て、クリックで 2.2 を呼び status が更新される | 2.2 | ✅ |
| 2.4 | (P1-13)行単位選択。`buildPartialPatch` にハンク内行選択→ヘッダ recount。vitest 追加。フロントで行チェック UI | builder | M | 1 ハンク内の一部行だけ stage が成立、追加 vitest グリーン | 2.1, 2.3 | ⬜ |
| 2.V | Phase 2 動作検証 | verifier | M | CRLF/Shift_JIS ファイルで stage/unstage/discard を検証、staged diff 実内容を確認 | 2.2, 2.3 | ✅ |
| 2.R | レビュー(パッチ生成の正確性重点) | reviewer | S | 指摘反映 | 2.V | ✅ |

> 補足: 2.4(行単位)は P1 精緻化。Phase 2 の Gate は 2.1–2.3(ハンク単位)で判定し、2.4 は後続に回してよい。

## Phase 3: コンフリクト解決(P0)

**Gate**: 実際に競合を作り(2 ブランチで同一行編集→ merge)、**ours / theirs / 手動編集の 3 経路**で解決 → 残マーカー 0 →「解決済み」→ continue でマージコミット生成、abort で復元 — を verifier 検証 + reviewer レビュー。

| # | タスク | 担当 | サイズ | 観測可能な完了基準 | 依存 | 状態 |
|---|---|---|---|---|---|---|
| 3.1 | 進行中オペレーションの continue/abort/skip。`merge/rebase/cherry-pick/revert` の各 `--continue/--abort/--skip`。API `POST /api/git/operation {dir,kind,action}`。0.2 と接続 | builder | M | マージ中に continue/abort が効く(dev) | 0.2 | ✅ |
| 3.2 | 競合ファイルの ours/theirs 採用。`checkout --ours/--theirs -- path` + `add`。(任意で stages `:1/:2/:3` 取得エンドポイント) | builder | S | 競合ファイルに ours 採用 → マーカー消えて staged | 0.2 | ✅ |
| 3.3a | 競合バナー一般化(operation 種別表示 + continue/abort/skip)。既存 merge-banner を置換 | builder | S | rebase/cherry-pick 中でも正しい種別と操作ボタンが出る(dev) | 3.1 | ✅ |
| 3.3b | 書き込み可能 Monaco で競合ファイル編集(**encoding 対応の既存 `files.ts` read/save 経路を再利用**)+ 競合ブロック毎 ours/theirs/both + 残マーカーカウンタ + 「解決済み(git add)」 | builder | M | 競合を編集で解決→マーカー 0 →解決済み→ continue でコミット | 3.1, 3.2 | ✅ |
| 3.V | Phase 3 動作検証 | verifier | M | ours/theirs/手動編集の 3 経路 + abort 復元を検証 | 3.3b | ✅ |
| 3.R | レビュー | reviewer | S | 指摘反映 | 3.V | ✅ |

> 補足: 3.3(競合 UI)は L のため 3.3a/3.3b に分割。3.2 は 3.3b と並行着手可。

## Phase 4: リモート/ブランチ操作(P0 残り + P1)

**Gate**: リモートのみのブランチをチェックアウト → tracking なローカルブランチが作成・切替 / rename が一覧に反映 / force-with-lease push が(ローカル bare リポジトリのテストリモートに)通り **bare `--force` は使わない**(コード確認) / 破壊系は danger モーダル経由 — verifier 検証 + reviewer レビュー。

| # | タスク | 担当 | サイズ | 観測可能な完了基準 | 依存 | 状態 |
|---|---|---|---|---|---|---|
| 4.1 | (P0-7)リモートブランチ→ローカル追跡ブランチ作成+切替(`switch --track` / DWIM)。BranchTree リモート context に「チェックアウト」 | builder | S | `origin/foo` を右クリック→チェックアウトで local `foo` が tracking で作成・切替 | - | ✅ |
| 4.2 | (P1-7)ブランチ rename(`branch -m old new`)。context メニュー + 入力 | builder | S | rename 後 branches 一覧に反映 | - | ✅ |
| 4.3 | (P1-5)upstream 設定 + **force-with-lease** push + pull --rebase。push `{force?:'with-lease';setUpstream?}`、pull `{rebase?}`。force は danger モーダル | builder | S | force-with-lease push がテストリモートに通る。コード上 bare `--force` 不使用を確認 | 0.3 | ✅ |
| 4.4 | (P1-6)リモートブランチ削除(`push origin --delete`)。context メニュー、danger モーダル | builder | S | `origin/foo` 削除がテストリモートに反映 | 0.3 | ✅ |
| 4.5 | (P1-8)リモート管理(remote add/remove/set-url + 一覧)。サイドバー「リモート」に管理 UI | builder | M | add/set-url/remove が `git remote -v` に反映(dev) | - | ✅ |
| 4.V | Phase 4 動作検証 | verifier | M | 各操作を(必要ならローカル bare リポジトリで)検証、破壊系の danger モーダルを確認 | 4.1-4.5 | ✅ |
| 4.R | レビュー | reviewer | S | 指摘反映 | 4.V | ✅ |

> 並列: 4.1/4.2/4.5 は相互独立、4.3/4.4 は 0.3 依存で並列可。

## Phase 5: 履歴操作(P1)

**Gate**: 各操作の graph 変化を verifier 検証 / 競合発生時に **Phase 3 の競合 UI へ遷移**して解決・完了できること / hard reset・force 系は danger モーダル経由 — reviewer レビュー(破壊的操作の確認フロー重点)。

| # | タスク | 担当 | サイズ | 観測可能な完了基準 | 依存 | 状態 |
|---|---|---|---|---|---|---|
| 5.1 | (P1-1)reset(soft/mixed/hard)を任意コミットへ。history commit context メニュー。hard は danger(未コミット変更があれば警告) | builder | M | 3 種の reset で HEAD 位置・ステージ/作業ツリー状態が期待通り | 0.3 | ✅ |
| 5.2 | (P1-3)cherry-pick(history から)。競合は Phase 3 UI へ | builder | M | 他ブランチのコミットを cherry-pick→適用、競合時は競合 UI へ遷移 | 3.1 | ✅ |
| 5.3 | (P1-4)revert(history から、`--no-edit`)。競合は Phase 3 UI へ | builder | M | コミットを revert→打ち消しコミット生成、競合時は競合 UI へ | 3.1 | ✅ |
| 5.4 | (P1-2)rebase(現ブランチを選択ブランチ上に)。continue/abort/skip は 3.1、競合は Phase 3 UI | builder | M | フィーチャーブランチを main に rebase→線形化、競合は競合 UI 経由で完了 | 3.1 | ✅ |
| 5.V | Phase 5 動作検証 | verifier | M | 各 graph 変化 + 競合遷移を検証 | 5.1-5.4 | ⬜ |
| 5.R | レビュー | reviewer | S | 指摘反映 | 5.V | ✅ |

> 並列: 5.2/5.3/5.4 は 3.1 依存で相互独立=並列可。5.1 は独立。

## Phase 6: タグ/スタッシュ差分/ファイル履歴/検索(P1)

**Gate**: タグの作成→ history 表示→ push→リモート反映→削除 / スタッシュの差分表示 / ファイル履歴一覧→過去バージョン diff / 著者で履歴フィルタ — verifier 検証 + reviewer レビュー。

| # | タスク | 担当 | サイズ | 観測可能な完了基準 | 依存 | 状態 |
|---|---|---|---|---|---|---|
| 6.1 | (P1-9)タグ: 一覧(サイドバー)+ 作成(軽量/注釈)+ 削除 + push(`push origin <tag>` / `--delete`)。削除は danger | builder | M | タグ作成→ history に出る、push→テストリモート、削除が反映 | 0.3 | ⬜ |
| 6.2 | (P1-10)スタッシュ差分閲覧(`stash show -p <ref>`)を DiffTabs で表示 | builder | S | スタッシュをクリック→差分表示 | - | ⬜ |
| 6.3 | (P1-11)ファイル履歴(`log --follow -- path`)+ 過去バージョン閲覧(既存 `getFileAtRev`)。ファイル context から | builder | M | あるファイルの履歴一覧→コミット選択で当時の内容 diff | - | ⬜ |
| 6.4 | (P1-12)履歴検索/フィルタ(`--grep`/`--author`/`-- path`)。graph-toolbar に検索欄 | builder | M | 著者で絞り込み→該当コミットのみ表示 | - | ⬜ |
| 6.5 | (P1-14, 任意)blame(`blame --porcelain`+ 行注釈) | builder | M | ファイルの blame で各行の commit/author が出る | - | ⬜ |
| 6.V | Phase 6 動作検証 | verifier | M | 各機能を dev で検証 | 6.1-6.4 | ⬜ |
| 6.R | レビュー | reviewer | S | 指摘反映 | 6.V | ⬜ |

> 並列: 6.1〜6.5 は相互独立=並列可(6.5 は任意)。

## Risks(リスク)

| リスク | 検出方法 | 顕在化したときの対処/緩和 |
|---|---|---|
| **R1 パッチ生成の不正確さ**(ハンク/行 stage でデータ損失) | `splitDiffHunks` vitest / dev で staged 側 diff の実内容確認 / `git apply` の非 0 終了 | サーバーで**権威 diff を再生成し index 照合**、latin1 バイト保存、失敗時は 409 で再読込指示(apply 失敗は index を変えない=ロールバック不要) |
| **R2 CRLF / autocrlf** | CRLF ファイルでのハンク stage テスト(vitest+dev) | **git 自身の diff を往復**(自前 diff しない)、`\r` を保持する行分割、`--ignore-whitespace` で誤魔化さない |
| **R3 非UTF-8 エンコーディング**(Shift_JIS 等) | Shift_JIS 日本語ファイルでの diff/patch 往復検証 | apply-hunks は **Buffer(latin1)でバイト保存**、コンテンツ表示/編集は既存 `encoding.ts` 経由、ours/theirs は `git checkout` に委譲(バイト安全)。**既知の弱点**: `diff-pair` の `fs.readFileSync(...,'utf8')`(index.ts:223 付近)は非 UTF8 で化ける → 競合編集は encoding 対応の `files.ts` 経路を使い、この経路には載せない |
| **R4 Windows・改行・パス** | Windows 実機 dev | 既存 `core.quotepath=false`/`unquoteGitPath` 踏襲、path は root 相対 forward-slash、`runGitInput` は spawn で shell 無効・`windowsHide` |
| **R5 破壊的操作の誤爆**(reset --hard / force push / discard all) | reviewer レビュー + 確認フローの動作検証 | `ConfirmDialog(danger)` 統一、force は**常に --force-with-lease**、影響範囲(ファイル/行数)明示、承認は都度 |
| **R6 gitMode=subdir のパス不整合** | subdir 登録リポジトリで**全新規操作を 1 本ずつ**検証 | 全 endpoint で `bodyDir`/`requireKnownDir` 正規化を必須化、path は常に root 相対 |
| **R7 進行中オペレーションの取りこぼし**(rebase 中に別操作) | `getOperationState` テスト / 競合中 UI ロック確認 | `operation!=null` の間は競合 UI 以外の破壊的操作を無効化 |
| **R8 認証**(`GIT_TERMINAL_PROMPT=0`) | push/pull がクレデンシャル要求で即失敗 | 資格情報ヘルパー前提を明記、失敗メッセージを表示、クレデンシャル UI は作らない(範囲外) |
| **R9 ネットワーク操作のハング/タイムアウト** | fetch/push の 120s タイムアウト | `NETWORK_TIMEOUT` 踏襲、UI に spinner と失敗表示 |
| **R10 型の手動同期ずれ**(types.ts ⇄ server) | `npm run typecheck` + レビュー | 新 interface 追加は types.ts と server を**同一タスク**で更新、既存の手動同期注記コメントを踏襲 |
| **R11 vitest 導入が build/typecheck に干渉** | `npm run typecheck`/`build` | vitest は devDependency に限定、test ファイルを既存 tsconfig の対象から適切に分離 |

## 申し送り(architect → Conductor)

- **フェーズ順は価値順(P0→P1)**。Phase 0→1 で「日々のコミット/マージ運用」が外部クライアント無しで回り始め、Phase 2(ハンク)と Phase 3(競合)で SourceTree 依存の 2 大要因が解消する。Phase 0–3 が本ミッションの中核。Phase 4–6 は「完全に不要になる」ための仕上げ
- **依存の要**は Phase 0(基盤)と Phase 3.1(operation continue/abort/skip)。後者に Phase 5 の cherry-pick/revert/rebase が全部ぶら下がるため、Phase 3 を Phase 5 より先に完了させること
- **テスト対象の核**は `splitDiffHunks`/`buildPartialPatch`(2.1)。R1/R2/R3 の主戦場。ケースに **CRLF・末尾改行なし・非 ASCII バイト**を必ず含めるよう builder に明示すること
- 検証は「`npm run typecheck` + `npm run test` + dev 起動で実操作」。破壊系(1.4/4.3/4.4/5.1/6.1)は**キャンセル経路**も verifier に検証させること(モーダルで止まり無変更であること)
