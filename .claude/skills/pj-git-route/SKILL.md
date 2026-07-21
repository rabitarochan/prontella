---
name: pj-git-route
description: claude-deck3 に Git 操作(サーバールート + API + UI メニュー)を安全に追加・変更するときの定石。3 層配線・引数インジェクション防壁・operation/busy ゲート・破壊的操作の確認・隔離スモーク+敵対的入力までを 1 枚に。builder への brief の References にこのファイルのパスを入れる。
---

# pj-git-route — Git 操作を追加する定石(claude-deck3)

Phase 0〜5 で約 9 本の Git 操作ルートを同一テンプレートで追加し、reviewer が敵対的入力で
繰り返し検証してきた実績のパターン。新しい Git 操作(タグ/stash/検索/blame など)を足すときは
この順で組む。

## 1. 3 層配線(+ 型の手動同期)

1. `server/git.ts` — `runGit(dir, args)` / `runGitInput(...)` を使う**薄い関数**。検証は書かず、
   git コマンドの実行だけに集中する(検証は呼び出し元=ルートの責務)
2. `server/index.ts` — ルート。`bodyDir(req)` / `requireKnownDir` で git root に正規化。
   成功は `res.json({...})`、エラーは `{error}` JSON
3. `client/src/api.ts` — `post<T>('/api/git/xxx', {...})` の 1 行ラッパー
4. `client/src/types.ts` と server 側の型は**同一タスク内で手動同期**(共有機構が無い。
   既存の同期注記コメントを踏襲)

## 2. 引数インジェクション防壁(最重要・reviewer の主戦場)

自由入力を git 引数に渡す新規コードは、**呼び出し元(ルート)で必ず検証する**。E2E は正常系しか
通さないので、ここが唯一の防壁になる(Phase 4 で rename の新名 `-f` が `git branch -m feature -f`=
move+force に化けてブランチ破壊する実インジェクションを reviewer が実証。Phase 5 では `git rebase
--exec="touch PWNED"` の任意コマンド実行を隔離再現し、下記ガードが遮断していることを確認済み)。

- **コミットハッシュ**: `/^[0-9a-f]{4,40}$/i` 不一致は 400。この正規表現は `-`・空白・改行・`..`・
  refspec を構造上含み得ないため、これだけで injection は不成立
- **ブランチ名・ref など `/`・`.` を含む自由入力**: 先頭 `-` を拒否(`!v || v.startsWith('-') → 400`)。
  危険オプション(`--exec`/`-x`/`--onto`/`-f` 等)は全て先頭 `-` なので、これが主防壁
- **`--` セパレーター**: git が受理する箇所のみ。**実測してから足す**(例: `git reset <commit> --` は
  パス形式=別解釈に化ける。`git rebase -- <onto>` は受理される)。先頭 `-` 拒否があれば必須ではない
- **400 を返すルートは asyncHandler(常に 500)でなく自前ラップ**にする:
  ```ts
  app.post('/api/git/xxx', (req, res) => {
    handleXxx(req, res).catch((err) => res.status(500).json({ error: String(err) }));
  });
  async function handleXxx(req, res) {
    const v = String(req.body.v ?? '');
    if (!v || v.startsWith('-')) { res.status(400).json({ error: `不正な v です: ${v}` }); return; }
    // ... git 実行 ...
  }
  ```

## 3. operation / busy ゲート(R7 + 二重実行抑止)

- 進行中オペレーション(merge/rebase/cherry-pick/revert、`getOperationState` が検出)の間は
  破壊的メニュー項目を `disabled: !!operation`
- **加えてローカル in-flight の `busy` も見る**。reset のように operation を生まない操作でも、
  実行中(busy=true)に別操作を並走させると git の index.lock で分かりにくいエラーになる
- **同型 UI を別コンポーネントに作るときは、既存の対称物の disabled 条件を必ず突き合わせる**
  (HistoryTab のコミットメニューが busy を見落とし、GitTab の rebase 項目だけ busy を見ていた
  非対称を 5.R が検出。`disabled: busy || !!operation` で揃える)

## 4. 破壊的操作の確認(R5)

- `ConfirmDialog`(`severity: 'danger'`)を必須。キャンセルで**完全無変更**(`if (!ok) return`)
- **影響件数は正確に**。例: hard reset の「失われる変更」は tracked(staged+unstaged)のみ数え、
  untracked は `reset --hard` が消さないので「保持されます」と別行にする(合算しない)

## 5. 検証(隔離スモーク + 敵対的入力)

- 隔離環境の起動・後始末は [[pj-isolated-verify]] に従う(短パス推奨=罠 5)
- **最低セット**: happy path 1 + 代表エラー 1〜2 + 近傍回帰 1。破壊系はキャンセル経路も
- **E2E の穴を敵対的に埋める**: 正常系+想定エラー系が通っても、`-f` / `--exec=` / 先頭 `-` /
  配列・オブジェクト body などの敵対的入力は別途突く(unit green・E2E green でも別の網)
- 競合し得る操作(cherry-pick/revert/rebase/merge)は、競合→Phase 3 の operation バナー+
  競合解決 UI へ遷移して continue で完走 / abort で完全復元、の両経路を確認

## 6. brief に貼れるチェックリスト

- [ ] git.ts 薄い関数 / index.ts ルート / api.ts / types.ts 同期の 4 点
- [ ] hash は正規表現、自由入力は先頭 `-` 拒否、400 は自前ラップ
- [ ] operation && busy で disabled、既存の対称メニューと条件を突き合わせ
- [ ] 破壊系は ConfirmDialog(danger)+ 影響件数の正確な明示 + キャンセル無変更
- [ ] 隔離スモーク(happy + エラー + 敵対的入力 + 回帰)、pj-isolated-verify 参照
