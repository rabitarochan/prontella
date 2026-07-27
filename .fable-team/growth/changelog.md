# Growth log for this project (changelog)

> Records the improvements /fable-team:grow and /fable-team:retro have made in this project —
> harvesting `pj-*` skills, adding project conventions, discarding signals — with rationale and effectiveness checks.
> Proposals to change the Fable Team framework itself go to the framework's repository.
> The next /fable-team:retro evaluates whether each change worked; if it did not, rewrite or remove it with /fable-team:grow.

---

## 2026-07-21 — /fable-team:grow(第 1 回。対象シグナル 18 件)

### 1. [新規 pj-Skill] `pj-isolated-verify`(.claude/skills/pj-isolated-verify/SKILL.md)

- **内容**: claude-deck3 の隔離検証環境手順(USERPROFILE 隔離 / ビルド→tsx 単体起動 / ポート選定 /
  罠 4 件: autocrlf・Volta シム・Monaco aria-hidden 入力・選択中 worktree 削除ロック / 代替パターン 2 種)
- **証拠**: 07-14 Friction(ポート衝突・PTY 再接続フリーズ)、07-20 Success+Friction(USERPROFILE 隔離、
  Volta 回避)、07-21 Success(Fiber executeEdits)+ 同日 3 ミッション/タスクで 5 回以上の反復実践
- **効果確認(観測可能)**: 検証系 brief の環境説明が「pj-isolated-verify 参照」の 1 行になり、
  隔離手順に関する Friction シグナル(同じ手順の書き写し・autocrlf/Volta の再踏み)が inbox に再出現しないこと

### 2. [フレームワーク変更提案 — Fable Team リポジトリーへ反映待ち] verify/playbook.md「Test Design」への追記 2 行

> - 読み捨てる上限(sanitize 等)を設けるときは、書き込み側の対称ガード+ユーザー通知をセットで設計・検証する
>   (非対称は「保存されたように見えて消える」無警告データ喪失窓になる)
> - 不可逆操作(discard 等)の楽観ロックは「数」でなく「対象の同一性」まで検証する(count 一致でも
>   位置ずれで別対象を破壊し得る)

- **証拠**: editor-state-persistence Rework(ドラフト 1〜2MB の無警告消失窓)/ git-client-parity で
  reviewer が実 git 再現した hunkCount-only ロックの誤破棄 — **別ミッションで同型 2 回**
- **効果確認**: 同型の非対称/同一性 Rework シグナルが inbox に再出現しないこと。reviewer/builder が
  設計段階でこのレンズを自発適用した事例が journal に現れること

### 3. [フレームワーク変更提案 — Fable Team リポジトリーへ反映待ち] brief/playbook.md への追記 2 行

> - 同一ファイルへの並列委任は、brief で編集領域を明示的に分割すれば worktree 隔離なしで成立する
>   (領域が分割できないなら並列にせず同一エージェントの継続で順次)
> - ハイリスクな純関数の brief には「実物を観察してから fixture を作る」「実機関門(git apply --check 等)
>   まで通す」を完了条件に入れる。新モジュールの brief では共有定数を依存の最下流(新モジュール側)に
>   置かせる(逆向き import は後続タスクで循環の手戻りになる)

- **証拠**: 07-20 Success(server/git.ts 並列編集)、07-21 Success(diffPatch で builder が実バグを
  実装中に自力検出)、07-21 Rework(editorState の循環 import 解消)
- **効果確認**: 並列編集の衝突・純関数の実機不整合・循環 import の Rework シグナルが再出現しないこと

### 4. [チェックオフ(変更不要)] 既存ルールの有効性実証 2 件

- 「レビュー小修正は元 builder へ SendMessage 継続」「中断エージェントは部分差分検証から再開」—
  いずれも brief/playbook.md に既載で、本日そのとおり機能した(検証済みとして記録のみ)

### 5. [チェックオフ(記録済み)] 4 件 / [破棄] 1 件

- gitMode 3 状態(メモリー済み)/ ConPTY 選別転送(メモリー済み)/ tsconfig extends の exclude
  (journal 済み)/ worktree 削除ロック(state.md 債務化済み)— 重複記録を避けチェックオフ
- git-branch-tree の論理反転 Rework — 挙動検証ゲートが設計どおり捕捉した事例。個別対策不要と判断し破棄

### ルールダイエット

- 直近 3 ミッションで無視・形骸化しているルールは観測されず、削除なし(資産はまだ痩身)。
  次回 /fable-team:grow で pj-isolated-verify の参照実績を確認し、使われていなければ書き直しか削除

## 2026-07-21 — /fable-team:grow(第 2 回。対象シグナル 5 件 — friction 2 / success 2 / failure→pattern 1)

### 1. [新規 pj-Skill] `pj-git-route`(.claude/skills/pj-git-route/SKILL.md)

- **内容**: claude-deck3 に Git 操作を安全に追加する定石を 1 枚に — 3 層配線(git.ts 薄い関数 →
  index.ts ルート → api.ts → types.ts 手動同期)/ 引数インジェクション防壁(hash 正規表現・自由入力の
  先頭 `-` 拒否・`--` は実測してから・400 は自前ラップ)/ operation && busy の disabled ゲートと
  対称メニューの突き合わせ / 破壊系の ConfirmDialog(danger)+ 影響件数の正確な明示 /
  隔離スモーク+敵対的入力の検証 / brief 貼り付け用チェックリスト
- **証拠**: シグナル 39(Phase 4 rename `-f` の実インジェクションを reviewer 実証)+ シグナル 41
  (Phase 5 busy/operation の非対称を 5.R 検出)+ Phase 0〜5 で同テンプレート約 9 本の反復 +
  Phase 6 で 5 本(タグ/stash 差分/ファイル履歴/検索/blame、多くが自由入力)を追加予定
- **効果確認(観測可能)**: Phase 6 の Git ルート追加 brief が「pj-git-route 参照」で足り、
  引数インジェクション/operation・busy の disabled 漏れ/3 層同期漏れの指摘が reviewer から
  出ないこと。同型の injection・非対称 disabled シグナルが inbox に再出現しないこと

### 2. [pj-isolated-verify 追記] 罠 5:スクラッチは短パス

- **内容**: 深いスクラッチパス(~180 字)で Windows の MAX_PATH により `git rebase` が
  `Filename too long`。フィクスチャは短パス(例 `C:\vt5`)に置く
- **証拠**: シグナル 40(5.V で実測・切り分け。短パスで同一フィクスチャ成功)
- **効果確認**: 隔離検証で MAX_PATH 由来の rebase 失敗 friction が再出現しないこと

### 3. [破棄] シグナル 37(Volta 回避)

- pj-isolated-verify 罠 2 に既載。5.4 builder が「罠 2 どおり」と認識して回避 = 第 1 回 grow の
  効果確認(「Volta の再踏みが再出現しないこと」)を**ポジティブに実証**。個別対応不要

### 4. [破棄] シグナル 38(E2E が UI 状態バグを掘る)

- 一般論は verify 合言葉「Green tests ≠ working software」で既カバー、具体の PromptDialog 修正は
  Phase 4 でコード反映済み。actionable な精神(E2E・敵対系は unit と別の網)は pj-git-route §5 に集約

### ルールダイエット

- pj-isolated-verify は Phase 5 で高頻度参照(5.V・全スモーク・builder の「罠 2 どおり」)され
  有効性実証済み → 第 1 回の「未使用なら書き直し/削除」の効果確認はクリア、削除なし。
  今回は痩身を保ったまま pj-git-route 1 枚を追加(pj-isolated-verify と役割分担: 環境手順 vs 実装定石)

### フレームワーク提案候補(Fable Team リポジトリーへ、未反映)

- 「シェル経由 CLI に自由入力を渡す新規コードは呼び出し側で先頭 `-` 拒否/形式検証する」は
  プロジェクト横断の原則。第 1 回の未反映提案 2 件があるため今回は project-local(pj-git-route)を主とし、
  横断提案は候補として記録に留める

---

## 2026-07-23 — grow 第 3 回(ミッション git-client-parity 完了時)

**処理シグナル: 29 件**(成功パターン 14 / 驚き 6 / 失敗→パターン 6 / 摩擦 3)。
全 29 件を収穫(破棄 0)。ミッション後半の 2.4(行単位ステージ)と 6.5(blame)で、
**検証ゲートとレビューゲートが独立にデータ破壊 4 件を出荷前に阻止した**経験が素材。

### 1. [新規 Skill・ユーザーレベル] `~/.claude/skills/git-patch-bytes`(148 行)

git の diff / パッチ / blame を**バイト単位で**扱うときの罠。**claude-deck3 固有の要素がゼロ**のため
プロジェクト外へ昇格。収めた 7 項目: バイト保存の原則(比較は生バイトのハッシュ)/ 部分パッチの
未選択行は**適用方向で扱いが逆転** / 変更ブロックは「削除全部 → 追加全部」で出るためペアリングが要る /
`\ No newline at end of file` marker は**位置の妥当性**が不変条件(context 行にも付く)/
**`git apply` の成功は正しさの証明にならない**(pre-image さえ合えば通る)/ `git blame` は生バイトを
`0x0A` で分割するので UTF-16LE がずれる / **正規表現に不一致の行を黙って捨てる実装は誤答製造機**。

- **根拠シグナル**: inbox 48・49・52・55・56・60・67・68
- **効果確認**: 部分パッチ・blame 系の新規実装で「apply 成功」や「テスト green」を合格根拠に
  した報告が上がらなくなること。同型のデータ破壊シグナル(行順序・行融合・無言の空)が
  inbox に再出現しないこと

### 2. [新規 Skill・ユーザーレベル] `~/.claude/skills/adversarial-verification`(141 行)

「動いているように見えるもの」を壊しにいく手法カタログ 10 種。**これもプロジェクト非依存**。
差分オラクル / 変異テストでテストの質を機械的に測る / **修正を打ち消す変異**で回帰保護を測る /
**対照実験で検出力を先に示す** / 構造的導出と実証をセットにする / 「壊せなかったこと」も報告させる /
証明の主張は反例探索の対象にする / 受入時の「疑い」を検証項目に降ろす /
見た目の修正は**指摘した本人**に解消を判定させる / 期待値は実装の出力でなく外部の事実から導く。

- **根拠シグナル**: inbox 51・53・57・61・64・65・66・71・72・74・75
- **効果確認**: verifier / reviewer への brief にこの Skill が References として入り、報告に
  「試したが不成立だった攻撃」節が現れること。**「実装者が自分の出力を期待値に固定した」型の
  rework シグナルが再出現しないこと**

### 3. [既存追記] `pj-git-route`(78 → 125 行)

§2 に `typeof` 先行チェック(配列 body が `"a,b"` に化ける罠)と**エラー種別は先頭アンカー付き照合**、
§2 のサブ節に**検証ロジックの純関数抽出**(supertest はモジュールスコープの副作用で実サーバー +
PTY が起動するため不可。先例は `checkApplyHunksRequest`)、§4 に**不可逆操作は頻度でなく
「ダイアログの申告が実際と一致するか」で切る**、§5 を新設して git コマンド固有の定石
(`--follow` + `--name-status` の origPath / `--fixed-strings -i` + `=` 埋め込みトークン)、
§1 に既知の非対称(stash-apply/drop が 400 でなく 500)を記録。

- **builder の良い判断**: §2 のコード例が `String(req.body.v ?? '')` という**シグナルが警告する
  脆弱パターンそのもの**だったため、単純追記でなく例自体を書き換えた(「教訓を書いた直後の例が
  教訓に違反する」矛盾を回避)
- **根拠シグナル**: inbox 42・43・44・45・58・62・76・77
- **効果確認**: 新規 Git ルートで配列 body・500/400 の非対称・無テストの判定ロジックが
  reviewer 指摘に上がらなくなること

### 4. [書き換え + 追記] `pj-isolated-verify`(55 → 80 行)= ルールダイエット

**手順 5 は死んだ規則だった。** 「ブラウザー検証は chrome-devtools MCP」と書かれていたが、
本ミッションで検証を担当した **3 体すべてがブラウザー MCP を持たず、全員が CDP 直叩き
ドライバーを自作**した。追記ではなく**書き換え**を実施し、chrome-devtools MCP は
「使える環境ならそちらでもよい」の 1 文に格下げ。新手順は起動 → 操作 → ダイアログ →
エラー監視 → エビデンス → **`getBoundingClientRect()` による実描画確認** → 配信アセットの
新規文字列 grep、という検証者が辿る順に再構成。旧記述の実質的知見(native dialog の扱い)は
CDP 版に引き継ぎ、罠 3(Monaco は React Fiber から `executeEdits()`)は温存して相互参照。

罠 6(サンドボックス・一時ファイルもスクラッチに置く)と罠 7(並行エージェントとの衝突回避 —
ポート/パスを別値に、Chrome kill は `--user-data-dir` で自プロセス特定、`node_modules` の
ジャンクションは `rmdir` でリンクのみ除去)を追加。

- **根拠シグナル**: inbox 46・69
- **効果確認**: 次のミッションで verifier が CDP ドライバーを**ゼロから発明し直さない**こと。
  プロジェクト直下に一時ファイルを作った旨の摩擦シグナルが再出現しないこと

### ルールダイエット

- **手順 5 の書き換えが今回のダイエット**(3 回連続で使われなかった規則を削除相当の扱いに)。
  新規 2 Skill はプロジェクト外へ置いたため、プロジェクト内の資産は
  pj-git-route + pj-isolated-verify の 2 枚のまま(205 行)で据え置き
- **次回の整理候補**(builder が正直に申告): `pj-isolated-verify` の「代替パターン」節に残る
  `evaluate_script` は chrome-devtools MCP 由来の用語で、CDP 直叩き前提に書き換えた手順 5 と
  用語が不整合。指示範囲(手順 5 のみ)を守って触っていない

### ドキュメントと実コードの食い違い(未解決・記録のみ)

- **`server/git.ts:1304` の `String(e).includes('no such path')` は先頭アンカー付きになっていない**。
  今回 pj-git-route に「先頭アンカー付きで照合する」と明文化したが、実コードは 6.5R の FYI(F-3)の
  ままで、**定石と実装が食い違っている**。builder が今回のドキュメント作業中に発見して報告した
- 6.5R は F-3 を「持ち越し可」と判定済み(再現には「パス名自体に `no such path` を含む tracked
  ファイルを worktree から削除する」という作為的な条件が要る)。**修正は締める方向で 1 行だが、
  未追跡ファイルの `notFound` 経路が壊れると 500 に戻る回帰リスクがあり、ゲートを閉じた後に
  検証なしで触るべきではないと判断**して据え置いた。次にこの周辺を触るときに一緒に直す

---

## 2026-07-23 — retro 効果確認(ミッション git-client-parity)

grow 第 1・2 回で入れた変更を、本ミッション全体(Phase 0〜6 + 2.4 + 6.5)に照らして評価。

### 効いた(ループが閉じた)

- **[第 2 回] pj-git-route** — Phase 6 / 2.4 / 6.5 の全 Git ルート追加 brief が References にこれを含め、
  **6.1 builder が配列 body 素通しの罠を自力で発見・修正**(typeof 先行を認識していた)。
  罠 5(短パス)は隔離検証の全報告で「罠 5 準拠」として参照された。**第 2 回の効果確認基準
  「Phase 6 の brief が pj-git-route 参照で足りる」はクリア**
- **[第 1 回] pj-isolated-verify** — 検証系 brief の環境説明が「参照」の 1 行に圧縮され、
  Volta・autocrlf・短パスの罠を verifier が再踏みせず回避。**ただし手順 5(chrome-devtools MCP 前提)
  は 3 体連続で未使用の死んだ規則だった → 第 3 回で書き換え済み(ルールダイエット)**。
  「未使用なら書き直す」という第 1 回の自己規定がそのまま発動した = メタレベルで効いている

### 効かなかった(ループが閉じていない)— 重要な発見

- **[第 1 回] verify/playbook「Test Design」への追記**(= 「期待値は実装の出力でなく外部から導く」)は
  **フレームワーク変更提案として「反映待ち」のまま留まり、実際には適用されなかった**。その結果、
  **2.4V でまさにその rework が再発**した(実装者が自分の出力を期待値に固定し、vitest 86 件 green の
  ままデータ破壊 2 件がすり抜けた)。**「反映待ちのフレームワーク提案はループを閉じない」**ことの
  直接証拠。同じく第 1 回の brief/playbook 提案 2 件も反映待ちのまま
- **対処**: 第 3 回で同じ教訓を**ローカル適用の Skill**(`adversarial-verification` = 検証手法、
  `pj-git-route` = ルート定石)として着地させた。**フレームワーク提案 3 件は、内容的にこの 2 つの
  ローカル Skill に包含されたため supersede 扱いとする**(Fable Team リポジトリー側の反映は任意)。
  教訓: **プロジェクトで今すぐ効かせたい学びは、反映待ちのフレームワーク提案でなくローカル資産に置く**

### 見積もりと現実の乖離(delegations.md × plan.md の Size 列)

- **Phase 0〜6 の中核(reset/リモート/競合/タグ等)はほぼ attempt 1・修正サイクル 0〜1 で収束**。
  見積もり(S/M)と現実がよく一致した
- **2.4(計画 M)は 11 委任・修正サイクル 2・データ破壊 3 件**。**6.5(計画 任意 M)は 9 委任・
  修正サイクル 2**。この 2 つ = **バイト単位の git パッチ / エンコーディング系**だけが桁で膨らんだ。
  トークンも 2.4 の 1 フェーズだけで subagent 合計 ~3.6M と、中核フェーズ群を上回った
- **教訓(記憶に保存済み [[deck3-byte-encoding-verification]])**: バイト保存・エンコーディング・
  不可逆操作に触れるタスクは、M 表記でも**ゲート複数回・データ破壊前提**で段取る。ただし
  **膨張は正しかった** — 発掘された 4 件はすべて実害で、出荷前に止められた。見積もりを外したことより
  「安く済ませようとしなかった」ことが正解だった

### この retro での資産変更

- なし(技術・手法の蒸留は第 3 回 grow で完了済み)。retro 固有の産物は上記の効果確認と
  記憶 1 件([[deck3-byte-encoding-verification]])のみ。**Bloat is death — ここで新規ルールは足さない**

## 2026-07-27 — grow 第 4 回(対象シグナル 12 件 — 失敗→パターン 4 / 驚き 3 / 成功パターン 3 / 摩擦 2)

出所は独立した 2 インシデント: ①ファイルツリーの新規作成入力が消える(commit b346519)
②ステータスバーで CRLF に変えても保存で LF に戻る。ユーザーからの是正指摘は 0 件。

### 1. [新規 pj-Skill] `pj-client-ui-state`(.claude/skills/pj-client-ui-state/SKILL.md)

クライアント(React / Monaco / react-arborist)の再レンダー・状態の寿命・設定適用の落とし穴 4 項目。
`pj-git-route`(サーバールート)と `pj-isolated-verify`(検証)はあったが、**クライアント UI 実装には
builder の brief に渡せる References 先が無かった**という穴を埋めるもの。今日その穴で不具合を 2 件出した。
収録基準(「実機で測って初めて分かった型」だけ・1 項目 10 行以内)を冒頭に明記し、増殖を抑える。

- 収録: ①行レンダラーをコンポーネント内で定義しない(react-arborist の identity)②ポーリング起因の
  切り分けは「値」より先に「ノードの同一性」③明示操作 > 設定ファイル(上書きフラグ)④設定
  スナップショットの鮮度と自己参照の 1 世代遅れ
- 証拠シグナル: 2026-07-27 の 78 / 79 / 80 / 85 / 86 / 89
- **効果確認**: 次にクライアント UI を触る委任で brief の References に指定されること。かつ
  「行レンダラー identity」「明示操作が設定ファイルに上書きされる」型のシグナルが inbox に再出現しないこと

### 2. [pj-isolated-verify 追記 + 既存記述の修正](80 → 83 行)

CDP 検証の実務 2 件。単なる追記ではなく、**既存記述が誤誘導していた箇所の修正**を含む。

- 現行の「`Runtime.evaluate` で操作する」はフォーカス/blur/クリック検証では誤り。untrusted event では
  ブラウザー既定のフォーカス移動が起きず、**正常な実装を NG と誤判定しかけた**。
  → 「フォーカス・blur・クリック起因だけは `Input.dispatchMouseEvent`(trusted event)」を明記
- `Runtime.evaluate` に `replMode: true` を付けると `awaitPromise` が効かず即座に空値が返る → 付けない
- 証拠シグナル: 2026-07-27 の 81 / 82
- **効果確認**: 「untrusted event で誤判定した」「replMode で空値が返った」型のシグナルが再出現しないこと。
  かつ次の UI 検証報告に `Input.dispatchMouseEvent` の使用が現れること

### 3. [ユーザーレベル Skill 追記] `~/.claude/skills/adversarial-verification`(141 → 156 行)

- **新規 §11「症状の消失は真因を潰した証拠にならない」**: 引き金(ポーリング・タイマー・再試行)が
  絡む不具合では、症状消失に加えて**引き金が従来どおり動作し続けていること**を独立した検証項目にする。
  引き金を止めるだけの修正も症状は消すので、症状の確認だけでは素通りする(証拠: シグナル 83)
- **§8 に 1 行追加**: 「実装者の証明主張」と同じ扱いを部下エージェントの報告にも当てる。
  **確信度ランキングは主張であって証拠ではない** — 事実は使い、順位は Conductor が組み直す
  (証拠: シグナル 87。scout がサーバー側 2 件を確信度「高」と報告したが実際は無罪で、
  真因は別の質問の回答本文に事実として現れていた)
- **効果確認**: 「症状消失だけで合格にした」「部下の確信度を鵜呑みにして誤診した」型のシグナルが
  再出現しないこと

### 4. [破棄] シグナル 88(ビルド成果物への新規識別子 grep)= 既存ルールの有効性実証

**すでに `pj-isolated-verify` の手順 5 に記載済み**で、verifier がそれに従って自主的に実施していた
(`client/dist` に `/api/fs/editorconfig` の文字列があるかを検証開始前に確認)。新しい学びではなく
**既存ルールが実際に効いた証拠**なので、チェックオフのみ。第 3 回の追記が第 4 回で回収された形。

### 5. [memory 更新] `claude-deck3-editorconfig-encoding`

`.editorconfig` はマッチする全セクションをマージするため、対象拡張子のセクションが無くても `[*]` の
指定が継承される(証拠: シグナル 84。実測で確認)。**効果確認**: editorconfig 絡みの調査で
「拡張子の記載が無いから無関係」と再び除外しかけたら、この記憶は届いていない。

### ルールダイエット

- `pj-isolated-verify` の手順 5 冒頭にあった経緯の説明 3 行(「verifier 3 体全員がブラウザー MCP を
  持たず全員が独自に自作した実績あり」)を 1 行に圧縮。**読み手の行動を変えない履歴**であり、
  残すべきは判断(CDP 直叩きが第一候補・MCP は代替)だけ。項目 2 の追記 +7 行に対し -3 行で相殺
- 新規 Skill を 1 本足したので、次回は `pj-*` 3 本の重複と死文をまとめて点検する(特に
  `pj-isolated-verify` の罠 4「選択中 worktree の削除」がまだ再現するかは未確認)
