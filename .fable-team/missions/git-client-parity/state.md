# Current state: git-client-parity

> **This file is the single source of truth.** Any session may die at any moment.
> Update it after every task completion and every checkpoint.
> If this file and reality (code, test results) disagree, reality is the truth. Record it in the journal and fix this file.

- slug: `git-client-parity`
- Phase: **DoD 全 8 項目 ✅ 充足済み。ユーザー判断により 6.5 blame(任意・DoD 外)を追加実装してから完了判定**
- Progress: 29 / 30 実装タスク完了(残は **6.5 blame** のみ)
- Last updated: 2026-07-23 00:30(2.4 ゲートクローズ + コミット確定 5c4f244。次は 6.5 blame)
- Updated by: Conductor session (resume, Opus 4.8)

## Next move (most important)

**次の一手: 6.5(blame = 行単位の履歴表示)を実装する。** DoD 全 8 項目は既に充足済みで、
2.4 のコミットも確定(5c4f244)。ユーザー判断により、**任意項目の 6.5 を追加してからミッション完了判定**する
方針が決まった。6.5 完了後: ゲート(verifier 実機 + reviewer)→ 完了判定 →
/fable-team:grow(inbox **13 件**)→ /fable-team:retro。新セッション再開時は /fable-team:resume-mission。

**6.5 の着手にあたっての前提**(plan.md Phase 6 と過去フェーズの実績から):
- 実装は 3 層配線(`server/git.ts` → `server/index.ts` → `client/src/api.ts`)+ 型の手動同期。
  **必読は `.claude/skills/pj-git-route/SKILL.md`**(引数インジェクション防壁・検証はルート側で 400・
  `typeof` チェックを先に置く・`--` セパレーター)
- blame は `path` と任意で `rev` を受け取る = **自由入力を git 引数に渡す新規ルート**。Phase 4 の rename で
  `-f` インジェクションが実際に成立した前例があるため、先頭 `-` ガードと `--` セパレーターは必須
- UI は Phase 6 の FileHistoryModal(`client/src/components/FileHistoryModal.tsx`)が最も近い前例。
  **Monaco は使わない**方針が Phase 6 で確立(既知債務 "TextModel got disposed" を構造的に回避)
- 検証は `.claude/skills/pj-isolated-verify/SKILL.md`(隔離・短パス・後始末)。
  **ブラウザー実機は CDP 直叩きドライバーで成立する**(6.V / 2.4V で実績)

### 2.4 の経緯(検証とレビューが独立にデータ破壊を計 3 件阻止)

2.4a(サーバー)→ 2.4b(UI)→ **2.4V ❌ 不合格(データ破壊 2 件)** → 2.4F → 2.4V' ✅ →
**2.4R ⚠️ 要修正(データ破壊 1 件 + 楽観ロックの穴)** → 2.4F2 → 2.4R 条件付き LGTM(機能欠落 + ダイアログの申告不一致)
→ 2.4F3 → **2.4R ✅ LGTM** + **2.4V'' ✅ 合格**。修正サイクルは上限 2 のうち 2 回を使用して収束。
vitest **63 → 123**、typecheck green。

**阻止した 3 件**: (1) 部分選択で**行の順序が入れ替わる**(全方向・全エンコーディング。`git apply` は成功し
vitest 86 件も green だった)(2) `@@` ヘッダーを変えない外部編集で**未見の内容が index に混入**
(3) **marker 追随で行が融合**(末尾改行なしファイルへの行追記という日常操作。91 ケース中 13 件)。
**いずれも「テストが緑」「apply が成功」をすり抜けた** — この機能ではその 2 つは無罪の証明にならなかった。

### 2.4 の最終構成
- **2.4a(サーバー側)= ✅ 完了・受入済み**: `buildPartialPatchLines` 新設(既存 `buildPartialPatch` は温存)+ ルートに並行配列 `lines?: (number[]|null)[]`(構造検証は diff 取得前・範囲検証は取得後、いずれも 400)+ `client/src/api.ts` 第 6 引数オプショナル。vitest 63 → **80**、typecheck green、隔離実 git 検証済み。**未コミット**
- **2.4b(UI)= ✅ 完了・受入済み**: `classifyHunkLine`/`selectableLineIndices` 追加(vitest 6 件)+ DiffHunkStrip 全面改修(164 → 283 行、アコーディオン展開・行チェック・選択リセットを `load()` の finally に一本化)+ styles.css。vitest 80 → **86**、typecheck green。**未コミット**
- **2.4V(verifier、隔離 CDP 実機 E2E)= ❌ 1 回目不合格**: **データ破壊バグ 2 件を検出**(下記)。**合格した項目**: E(UI 実機 — チェック可能行の限定・未チェックで非活性・danger 確認とキャンセル無変更・選択リセット・別ハンク開き直しでクリア・レイアウト崩れなし)/ G(回帰 — vitest 86・typecheck・ハンク単位経路・stage-all→コミット→履歴・新規コンソールエラー 0)/ エンコーディング保存(CRLF の `\r\n` 完全保存・SJIS の U+FFFD 混入なし)。**D の補足**: 実 UI は `runApply` が常に単一要素 `[index]` しか送らないため、複数ハンク同時選択の累積オフセット計算は**UI から到達不能なデッドコード**(2.4a の「3 ハンク以上未実測」懸念は UI 経由では発生しない)
- **2.4F(新規 builder)= ✅ 完了・受入済み**: 下記 2 件を修正。**不具合 1**: `transformHunkLines` を書き直し — 変更ブロックの連続 `-` を `D[]`・続く連続 `+` を `A[]` に集め、`k=min(|D|,|A|)` 個を**インデックスでペアリングしてペア順にインターリーブ出力**、余りは元の相対順で単独行として後置。**行ごとの選択/方向の判定ロジックは不変で、出力順序だけを変更**。marker は内容行に紐付けて並び替えに追随、末尾番人は退避して最後に復帰。**不具合 2**: 行選択があるハンクのみ `expectedHunkLines`(ハンク本体全文)を **utf8 側の権威 diff** と突き合わせ、不一致・欠落・形不正はすべて 409。ハンク単位経路は不変。vitest 86 → **102**、typecheck green。**修正前コードに新規 16 件中 9 件が実際に落ちることを確認済み**
- **2.4V'(再検証、2.4V と同じ verifier を継続)= ✅ 合格**: 前回の不合格根拠を同一手順で再実行して両方とも解消。先頭/後方/飛び石 × forward・reverse × 平文・CRLF・SJIS の 9 パターンで適用後の実バイトが正しい順序 / 409 は API 直叩きと実 UI の両方で発生し index 空・worktree 無変更 / **新規網羅**: m≠n の 5 ケース(2→3・3→2 の余り選択/非選択・純挿入・純削除)で余りが「ペアの後ろに元の相対順」で正しく配置 / 末尾改行なしの marker 追随(生バイトで行融合の解消を確認)/ 日本語 UTF-8 で**偽 409 なし** / UI 実機(チェック→適用・409 通知と選択リセット・discard の ConfirmDialog)/ 回帰(vitest 102・typecheck・ハンク単位経路・新規コンソールエラー 0)。**新規不具合ゼロ**
- **2.4R(reviewer、Opus、新規スポーン)= ⚠️ 要修正**: **must-fix 1 / recommended 4 / FYI 3**。**新たなデータ破壊を実 HTTP + 実 git で再現**(下記)
- **2.4F2(修正サイクル 1、2.4F の builder を継続)= ✅ 完了・受入済み**: 指摘**全件**を実装。(1) marker は「組立 → 違反検出 → 原因ペアの自動引き込み → 再試行」の**境界付き・単調増加**アルゴリズム + 解消しなければ throw(フェイルクローズド)、番人は**位置ベース**(2) `hashHunk`(latin1 バイトの SHA-256、`node:crypto`)を `GET /api/git/diff-hunks` が返し全選択ハンクで**無条件照合**、`expectedHeaders`+`expectedHunkLines` を `expectedHunkHashes` に置換 (3) `checkApplyHunksRequest`/`hashHunk` を**純関数抽出**(ルートの ~110 行が呼び出し 1 つに) (4) `classifyHunkLine(line, isSentinelPosition)`、`selectableLineIndices` 削除 (5) context・marker のみ選択を **400 に昇格**。vitest 102 → **120**、typecheck green。marker 処理部を一時的に戻して 2 つの再現テストが実際に落ちることを確認済み
- **2.4R 修正確認(同 reviewer 継続)= ⚠️ 条件付き LGTM**: **指摘 7 件すべてが実証つきで閉じ、データ破壊経路は残っていない**(marker 融合は両方向で解消 / プロパティテスト **97 ケースで行数不変条件違反 0**(修正前 91 中 13)/ SJIS 楽観ロックとハンク単位経路も閉塞 / バイト不変性 97 ケースで違反 0 を維持 / 敵対的 body 17 種すべてフェイルクローズドで完全無変更 / **偽 409 は構造的に不可能**(GET と POST が同一 Buffer を同一 latin1 デコードでハッシュ化)/ `expectedHeaders` 廃止による検知後退なし(ハッシュ対象に header が含まれ真部分集合として保存、本体変化も無条件で拾うため**検知能力は真に増加**)/ 追加テストは実装をなぞっていない)
- **2.4F3(修正サイクル 2 = 最終、同 builder 継続)= ✅ 完了・受入済み**: N-1 は違反 marker 行**自身の出力プレフィックス**で分岐(`' '`= 引き込み / `'-'`・`'+'`= **その行の marker を破棄**)、リトライは 2 つの単調増加集合を追跡し上限 `parsed.length*2+1`。N-2 はコメント訂正 + 正しい根拠(「marker は常にその時点の出力の真の EOF にあり context 行は元順序で素通しされるため正当に後続するものが無い」)。(b) は `discardLines` に保守的過剰近似の警告。vitest 120 → **123**、typecheck green。**builder 自身が独立な不変条件チェッカーで 700 回ファジングして失敗 0**(ただし「reviewer の 3 件が既知 2 パターンの変種である」ことは証明できないと正直に申告)
- **並行実行中(いずれも読み取り専用・ファイル競合なし。ポートとスクラッチは別値を指示済み)**:
  - **2.4R 最終確認(reviewer 継続)= ✅ LGTM・新規問題ゼロ**: 自前の独立オラクル 2 系統で再探索 — (a) **往復オラクル**(実装知識ゼロ。部分選択を差分が尽きるまで繰り返し、最終的に index が worktree と**バイト完全一致**するか。marker を誤って落とせば末尾改行が増減して必ず露見)で stage 102 ステップ・discard 106 ステップの**不一致 0**、(b) 独立パッチチェッカー + `git apply --check` で 570 ケースの違反 0・失敗 0。**オラクルの検出力自体も実証**(偽ったパッチは `--check` が確かに落とす)= **suppress が pre-image を偽った事例ゼロ**。過剰拒否は**計 1,200 ケース超で再現 0**(前回は約 3/97)。最大拡大は**2 行 = ちょうど 1 ペア**で構造的に上限。合成配置 46 組合せでハング・無限ループ 0。**(b) の警告は 592 試行で偽陰性 0**(構造的にも拡大 ⟹ 警告が成立)。回帰全件維持(バイト不変性 256 比較で不一致 0 / 敵対的入力 19 種 / SJIS / `suppressBlankEmpty` / vitest 123・typecheck を自走)。**ミッション完了判定に同意 — 完了前に潰すべきものは残っていない**
  - **2.4V''(verifier 継続、UI 実機の最終確認)= 🔄**: **契約変更(`expectedHunkHashes`)で全操作が 409 になっていないか**が最優先 / 日本語・SJIS で偽 409 なし / 競合検知が実 UI で効くこと(**ハンク単位経路も含む** — 今回新たに保護された)/ **破棄ダイアログの警告文は実機で一度も表示確認されていない = この検証が初回** / 末尾改行なしファイルへの追記行だけをステージ(最初のデータ破壊バグの再現操作)/ UI 回帰・Git タブ回帰

### 【仕様として確定】行単位選択の EOF ペア引き込み(債務ではない)

**行単位選択では、末尾改行に関わる EOF 修正ペアが自動的に実効選択へ引き込まれ、
最大 1 ペア分(2 行)の拡大が起こり得る。** これは不具合ではなく設計判断で、
「新しい内容を捏造せず既存の D/A ペアだけを使う」という制約下では不可避
(reviewer が構造的な上限まで確認済み: git は 1 ファイルの diff に marker を最大 2 個しか出さず、
うち引き込みを誘発するのは context 化されたものだけ)。
**discard(不可逆)のときだけ確認ダイアログで警告する**(保守的な過剰近似。偽陰性ゼロを 592 試行 +
構造的論証で確認)。stage/unstage は可逆かつ結果が即座に画面反映されるため警告しない。
※ reviewer の推奨により、債務ではなく**仕様の記録**としてここに残す。

### 2.4R が残した 2 件(いずれも**破壊を伴わない**。修正サイクル 2 で解消済み)

**N-1(recommended・過剰拒否)**: **builder の「実 git で到達可能な入力なら引き込みで必ず解消する」
という証明は反例で崩れた**。ランダム 97 ケース中 **3 件**が、チェックボックスから到達可能な選択で
throw(HTTP 500)に落ちる。実 HTTP 再現: HEAD `"d\nd\ne\nf\na\na\ng\nb"`(末尾改行なし)/
worktree `"d\nd\ne\nf\na\na\ne"` で `-g`(idx3)と `+e`(idx6)を選択 → 500(index 無変更 ✓)。
**過剰拒否の証明**: 正しいパッチは存在し git が受理する(marker を context `' b'` に残し `+e` から外す)。
原因は marker を**常に**内容行へ追随させること。**正解は引き込みではなく marker の破棄**
(`e` は最終行でないので実際には改行を持つ)。
修正規則: marker が `+`/`-` 行に付き主張側に後続内容がある → **marker を落とす** /
context 行の marker(両側主張)は現行どおり引き込む / どちらでも解消しなければ throw 維持。

**N-2(recommended・コメントの誤り)**: `diffPatch.ts:274-276` の「context 行に marker が付くことは無い」は
**事実と異なる**(最終行が未変更で末尾改行が無ければ実 git は必ず context 行に付ける。実証済み)。
処理は正しく動くが、その理由は「context に付かないから」ではなく「**EOF marker は常に終端にあるため
ガードが発火しないから**」。`pullIndices = []` の設計判断とテスト戦略の根拠が誤った前提に乗っている。
**FYI(現状到達不能)**: ガードの `prefix = line[0]` は `suppressBlankEmpty` 由来の空文字列 context に
対し `undefined` になり `isOld`/`isNew` がともに false になる。

**新論点への判定 = (b) discard 限定の保守的警告**: 実測頻度は本リポジトリーで**末尾改行なしファイルが
89 中 1 件(1.1%)**、拡大発生率は**行単位操作の 0.1% 未満**。それでも (a) 許容を採らない理由は頻度ではなく
**確認ダイアログが嘘をつく**こと(現文面 `選択した N 行を破棄しますか?` が実際の影響と食い違う)。
`pj-git-route`「影響件数は正確に」と DoD「破壊的操作は統一 ConfirmDialog(danger)経由」に衝突する。
**stage/unstage は対象外**(可逆かつ適用後 `load()` で結果が即座に画面反映されるため目視できる)
= Conductor の「適用方向で許容度が違う」という見立てを reviewer が支持。**(c) 拒否は過剰**。
実装は**保守的な過剰近似**(`lines.some(l => l.startsWith('\\'))` があり選択が全 add/del を覆わないときだけ
1 文追加)。**厳密な事前計算はサーバーロジックのクライアント複製になり、過去に非対称バグを生んだ経路なので採らない**。

**Conductor 判断**: reviewer は「2 件を持ち越し債務にして完了判定する選択も成立する(ユーザー判断)」と
したが、**直すを採った**。理由: (i) N-1 は正当な操作が 500 で止まる**機能欠落**でミッションの目的
(外部 Git クライアント不要)に直接反する (ii) (b) は不可逆操作の申告と実際の食い違いで DoD の明文と衝突
(iii) 両者は同じ marker ロジックの一箇所でコストが小さい(N-1 約 15 行 + テスト 2〜3 件、(b) 約 8 行)。
**これが上限 2 サイクルの最終回**。収束しなければユーザー判断を仰ぐ。

### 2.4R の指摘(修正サイクル 1 で対応中)

**must-fix(データ破壊・実証済み)**: **`\ No newline at end of file` marker が context 化された行に追随し、
後続に出力行があると行が融合する**。再現: HEAD `"a\nb"`(末尾改行なし)/ worktree `"a\nb\nc\n"` で
`+c` **だけ**を選択 → **HTTP 200** で成功しながら index が `"a\nbc\n"`(期待 `"a\nb\nc\n"`)。
discard 方向も実証(`"p\nQ"` に `-r` だけ破棄 → `"p\nQr"`、**不可逆**)。プロパティテスト 91 件中 **13 件(14%)**
が違反し**全件 apply 成功扱い**。トリガーは「末尾改行なしファイルへの行追記」= 日常操作。
**2.4a から存在した経路**で、2.4F のペアリング修正が原因ではない。
機構(Conductor も独立に追跡): marker は「直前行が**両側で**最終行かつ改行なし」と主張するため、
後続の `+c` と矛盾し git が `"a\nb"+"c\n"` = `"a\nbc\n"` と解釈する。
修正: (1) marker 位置の不変条件ガード(違反は throw = フェイルクローズド)+ (2) marker を持つ
EOF 修正ペアを選択に自動的に引き込む。

**recommended 2+3(データ損失・実証済み。1 つの修正で両方閉じる)**: `expectedHunkLines` の照合が
**utf8 の非可逆デコード上**のため非 UTF-8 で素通しする(SJIS「あ」`82a0` と「い」`82a2` が
utf8 デコードで**同一文字列**になり 409 を通過して混入。**本プロジェクトは SJIS を実際に扱う**)。
加えてハンク単位経路(`lines[i]===null`)には不具合 2 の穴がそのまま残る。
修正: `GET /api/git/diff-hunks` がハンクごとに**生バイトのハッシュ**を返し、クライアントがエコー、
サーバーはハッシュで**無条件に**照合。※ Conductor が前回課した「ハンク単位経路は変更しない」制約は**撤回**した
(行選択だけ守る非対称に防御上の根拠がないため)。

**recommended 4(Conductor が委ねた論点への回答)**: **supertest は入れない**。`server/index.ts` は
モジュールスコープで `express()` / `new PtyManager(PORT)` / `app.listen` を実行するため import で
実サーバーと PTY が起動する = 導入はルート抽出リファクタリングとセットで過大。代わりに
**検証ブロックを `diffPatch.ts` 側の純関数へ抽出**して既存 vitest でテスト(新規依存ゼロ)。

**recommended 5(潜在)**: `diff.suppressBlankEmpty=true` で空行 context が空文字列になり、
末尾番人と誤認 / ハンク中央なら 500 / UI で空行が消える。修正: 番人判定を**値でなく位置**
(最終ハンクの `lines.length-1`)で行う。**Conductor 確認: ユーザー環境では local/global とも未設定**。

**FYI**: `selectableLineIndices` はデッドコード(export + vitest 2 件が付くが未使用)/ context・marker のみ
選択が 400 でなく 500(純関数抽出のついでに 400 化)。

**reviewer が「壊せなかった」こと(再調査不要)**: 「`-` 全部 → `+` 全部」前提の反例を **11,200 サンプル**
(4 アルゴリズム × 7 オプション × 400 シード)探して **0 件** / m≠n の余り後置・複数変更ブロック・
クロスペア選択・CRLF で pre-image 破壊なし / ハンク単位経路のバイト不変性はプロパティテスト 91 件で違反 0 /
utf8-latin1 の**添字**対応は崩せない / 敵対的 body 13 種すべて 400・409 で index/worktree 完全無変更 /
UI の disabled 非対称は新規に無く選択リセットは全経路を覆う / **追加テストは実装をなぞっていない**
(実 git の staged blob を実バイト比較)。

### 2.4V が検出したデータ破壊バグ 2 件(2.4F で修正済み・再検証中)

**不具合 1(最重要・行順序の破壊)**: 2 行以上の変更があるハンクで先頭側のペアだけ選ぶと、適用後のファイルで
**行の順序が入れ替わる**(実測: `line1, line3, line2-CHANGED, line4` — 正しくは `line1, line2-CHANGED, line3, line4`)。
stage / unstage / discard の全方向、平文・CRLF・SJIS すべてで再現。verifier は `buildPartialPatchLines` を
直接呼んで生成パッチを実 git に通し二重に確認。
**機構(Conductor が独立に導出)**: git diff は複数行変更を「削除ブロック → 追加ブロック」でまとめて表現するため、
`transformHunkLines` の「未選択 `-` を context 化・未選択 `+` を削除」を**生の行順のまま**適用すると
post-image の順序が壊れる。**pre-image は正しいので `git apply` は成功してしまう**
(= apply が通ったことを合格判定に使ってはいけない)。
修正方針の仮説: 変更ブロック内で i 番目の削除行と i 番目の追加行をペアにしペア順にインターリーブ出力。
m ≠ n(削除数 ≠ 追加数)の定義は未解決 → builder に実 git で詰めさせ、押し戻しも明示的に許可済み。

**不具合 2(重大・409 の穴)**: 行選択後、外部プロセスがハンクの開始行・行数を変えない範囲で内容だけ変更すると
**409 にならず `ok:true` で成功し、選択していない外部編集の内容が index に混入**(実測 `a1-EXTERNAL`)。
修正方針: 行選択があるハンクは**ハンク本体全体**の内容(全文 or ハッシュ)まで照合し不一致なら 409。
フェイルクローズド。**比較は utf8 側で行う**(latin1 側と比較すると日本語で偽 409 — 既存コメントに罠の記載あり)。
ハンク単位(行選択なし)の既存経路は変更しない。

**重要な教訓**: vitest 86 件 green が不具合 1 を 1 件も捕まえなかった。前任 builder が**自分の実装の出力を
そのまま期待値に固定**したため。修正 brief では「現行コードに対して落ちる回帰テストを先に書く」
「期待値の根拠は実 git に apply した後の post-image」を強制済み。

**2.4R への申し送り(元は Conductor がコード実読で予測した論点。2.4V が実害として再現済み)**: `expectedHunkCount` + `expectedHeaders` の
楽観ロックを継承しているが、これは**「`@@` ヘッダーが同一のままハンク内の行の内容だけが変わる」変化を検出できない**。
クライアントが送るのは**添字のみ**で、パッチは**サーバーが要求時点で取り直した権威 diff** から組み立てられるため、
開始行・行数が変わらない編集(変更済み行のテキスト書き換え等)が確認ダイアログ表示中に起きると、添字 i が
ユーザーの見た行と別の行を指したまま適用され得る。ハンク単位では影響が限定的だったが、行単位では粒度が細かく
discard で意図しない行の消失に至り得る。Phase 2 で reviewer が `hunkCount` のみの楽観ロックの盲点を実 git で
再現して `expectedHeaders` を追加させた経緯の**同型の次段**。再現可否と対処要否を 2.4R に判定させる。

**核心(brief に明記済み・builder に実 git で裏取りさせている)**: 未選択行の扱いは**適用方向で逆転**する。
前進適用(stage = `git apply --cached`)は未選択 `-` を context 化・未選択 `+` を削除。
逆適用(unstage = `--cached --reverse`、discard = `--reverse`)は未選択 `+` を context 化・未選択 `-` を削除。
`discard` は diff の取得元が worktree でも**逆適用側**である点が取り違えやすい。

### 現在の作業ツリー(未コミット・**ゲート通過済みで安全**)

実装 8 ファイル: `server/diffPatch.ts` / `server/diffPatch.test.ts` / `server/index.ts` /
`client/src/api.ts` / `client/src/types.ts` / `client/src/diffHunk.ts` / `client/src/diffHunk.test.ts` /
`client/src/components/DiffHunkStrip.tsx` / `client/src/styles.css`。
記録 4 ファイル: `mission.md`(DoD 全チェック)/ `plan.md` / `state.md` / `journal.md` / `delegations.md` /
`.fable-team/growth/inbox.md`。

**コミット提案**(Phase 4/5/6 と同構成、ユーザー承認待ち):
1. `feat(git): 行単位のステージ・アンステージ・破棄を追加 (Phase 2.4)` — 実装 8 ファイル
2. `chore(fable-team): ミッション完了のチェックポイント` — 記録一式

### 直近の事実

1. テスト現状: vitest **123 件** + typecheck green(2.4R が実走で再確認、Conductor も手元で再実行)
2. コミット済み: bb7462a feat(git) Phase 6 一式 + 596e7a2 chore(fable-team) チェックポイント
3. **6.5 blame は任意・DoD 外**で未実施 — ミッション完了とするなら別ミッション候補
4. 未処理の growth signal は **13 件**(2.4 で 8 件追加)→ /fable-team:grow を提案済み

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

2026-07-22 14:42 — 新セッションで復旧・現実突合済み(bb7462a / 596e7a2 実在、vitest 63 green、plan.md 2.4 は ⬜)。
未コミットは本ファイルと journal.md のみ(コミット確定の記録そのもの。次チェックポイントで回収)。
ユーザー判断待ち(次の一手: 2.4 / 6.5 / 完了判定、および /fable-team:grow 実施可否)。
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
