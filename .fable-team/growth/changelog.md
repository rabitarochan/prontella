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
