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
