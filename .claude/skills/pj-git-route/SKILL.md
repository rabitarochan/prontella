---
name: pj-git-route
description: claude-deck3 に Git 操作(サーバールート + API + UI メニュー)を安全に追加・変更するときの定石。3 層配線・引数インジェクション防壁(typeof チェック・純関数抽出を含む)・operation/busy ゲート・破壊的操作の確認・git コマンド固有の定石・隔離スモーク+敵対的入力までを 1 枚に。builder への brief の References にこのファイルのパスを入れる。
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

**既知の非対称(新規コードは踏襲しないこと)**: `stashApply`/`stashDrop`(`server/git.ts`)は
例外的に検証を git.ts 内で行っており、呼び出し元ルートが `asyncHandler` のため不正な stash 参照は
400 でなく 500 になる。新規ルートはこの非対称を踏襲せず、上記の原則どおり検証をルート側(自前
ラップ)に置くこと。

## 2. 引数インジェクション防壁(最重要・reviewer の主戦場)

自由入力を git 引数に渡す新規コードは、**呼び出し元(ルート)で必ず検証する**。E2E は正常系しか
通さないので、ここが唯一の防壁になる(ブランチ破壊・任意コマンド実行の実インジェクションを
reviewer が実証済み)。URL・パスなど git 以外の信頼できない入力は [[pj-untrusted-input]] を見る。

- **`typeof` チェックを先に置く**: `String(req.body.x ?? '')` 型の検証は、配列 body
  `["a","b"]` を `"a,b"` に化かして素通しさせる(6.1 builder が敵対的テストで実測)。
  必ず `typeof x !== 'string'` を最初に見てから空・先頭文字のチェックへ進む
- **コミットハッシュ**: `/^[0-9a-f]{4,40}$/i` 不一致は 400。この正規表現は `-`・空白・改行・`..`・
  refspec を構造上含み得ないため、これだけで injection は不成立
- **ブランチ名・ref など `/`・`.` を含む自由入力**: 先頭 `-` を拒否(`!v || v.startsWith('-') → 400`)。
  危険オプション(`--exec`/`-x`/`--onto`/`-f` 等)は全て先頭 `-` なので、これが主防壁
- **`--` セパレーター**: git が受理する箇所のみ。**実測してから足す**(例: `git reset <commit> --` は
  パス形式=別解釈に化ける。`git rebase -- <onto>` は受理される)
- **ただし remote 位置の引数では `--` は必須**(先頭 `-` 拒否があっても省略しない)。
  `fetch`/`push`/`pull` の remote 引数は**任意コマンド実行の経路**で、実測:
  ```
  git fetch "--upload-pack=echo pwned" <remote> <refspec>
    → fatal: protocol error: bad line length character: pwne   ← echo が実行されている
  git fetch -- "--upload-pack=echo pwned" <refspec>
    → fatal: strange pathname '--upload-pack=echo pwned' blocked
  ```
  `fetch`/`push`/`pull --ff-only` の 3 つとも remote 手前の `--` を受理する(実測済み)。
  さらに **`git check-ref-format refs/heads/-x` は exit 0**(先頭 `-` の refname は正当)なので、
  既存コメントにある「値は git 由来だから安全」という論法は**成立しない**。git 由来の値にも
  先頭 `-` ガードと `--` を両方かける。
  **最も確実なのは remote をリクエストボディで受け取らないこと** — ルート側で
  `listBranches(dir)` / `listRemotes(dir)` を引き直し、git 由来の値だけを流す
- **エラー種別の判定に `String(e).includes('...')` を使うときは先頭アンカー付きで**: 引用された
  パス名の中の文字列にも当たってしまう(例:「no such path.txt」というファイル名で意図しない一致が
  起きた実測あり)。`/^fatal: no such path /` のように発生位置を固定した正規表現で照合する
- **400 を返すルートは asyncHandler(常に 500)でなく自前ラップ**にする:
  ```ts
  app.post('/api/git/xxx', (req, res) => {
    handleXxx(req, res).catch((err) => res.status(500).json({ error: String(err) }));
  });
  async function handleXxx(req, res) {
    const v = req.body.v;
    if (typeof v !== 'string' || !v || v.startsWith('-')) {
      res.status(400).json({ error: `不正な v です: ${JSON.stringify(v)}` });
      return;
    }
    // ... git 実行 ...
  }
  ```

### 検証ロジックは純関数に切り出す(ルートテスト基盤が無い代替)

`server/index.ts` はモジュールスコープで `express()` / `new PtyManager(PORT)` / `app.listen` を
実行するため、supertest 等を入れると import しただけで**実サーバーと PTY が起動する**。
ルートテスト基盤の追加は「ルート定義を別モジュールへ抽出するリファクタリング」とセットになり、
単発の検証ニーズに対してコストが大きい(2.4R 判断)。

代替は**検証ロジック(型・範囲チェック、409/400 判定)の純関数抽出**(新規依存ゼロ)。
先例: `server/diffPatch.ts` の `checkApplyHunksRequest`(POST /api/git/apply-hunks のリクエスト
検証 + 409 判定を純関数化し vitest で固定した恒久回帰テスト)。

**切り出し先は `server/index.ts` の export ではなく別モジュール**(`server/diffPatch.ts` のように)。
index.ts に置くとテスト側が index.ts の import を強いられ、上記の実バインドを避けるために
`vi.mock('node:http')` が必要になる(実測: 副作用は出ないが、後日 index.ts のモジュールスコープに
I/O が足されると気付かず踏む)。新規の検証純関数は最初から別モジュールへ置く。

逆に、**async + 実 git 依存の関数の中に判定ロジックを埋め込むと、純関数テストの網に載らず無テスト
のまま残る**(例: `getBlame` の `notFound` 判定。`server/git.ts` の async 関数内にあり専用テストが
無い)。新しいルート/IO 関数を書くときは、判定ロジック(検証・分類・エラー変換)を最初から
呼び出し可能な純関数として切り出す規約にする。

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
- **不可逆操作の許容判定は「頻度」ではなく「確認ダイアログの申告が実際と一致するか」で切る**。
  ある拡大(影響範囲が申告より広がる現象)の発生率が 0.1% 未満と実測されても、申告文言
  (「選択した N 行を破棄します」等)と実際の影響が食い違うなら許容しない。**可逆な操作
  (stage/unstage)とは許容度が違う**(discard 等の不可逆操作は保守的に倒し、可逆操作は
  `load()` で結果が即座に画面反映され目視できるため許容範囲が広い。2.4R 判断)

## 5. git コマンド固有の定石

- **`git log --follow` の per-commit 旧パス**は `--name-status` を併用して取得し、その旧パス
  (`origPath`)を diff 取得(`diff-pair` 等)へ必ず渡す。渡さないとリネーム前のコミットが
  「新規ファイル」として誤表示される(6.3 実測)
- **自由入力の検索条件**(`--author=`/`--grep=`)は `--fixed-strings -i`(`--regexp-ignore-case`)を
  必ず併用し、値は**`=` 埋め込みの単一 argv トークン**(`--author=${v}` であって `--author`,
  `${v}` の 2 トークンにしない)にする。前者は regex メタ文字によるクラッシュ、後者は
  `--upload-pack=` 系の任意コマンド実行インジェクションの両方を封じる(6.4 実測)
- **出力のロケール依存を env(`LC_ALL=C` 等)で潰す案が出たら、先に同等の plumbing コマンドを探す**。
  `%(upstream:track)` の `ahead N`/`gone` を翻訳する `setup_ref_filter_porcelain_msg()` は
  `builtin/branch.c` からしか呼ばれないため、`git branch --format` は翻訳され得るが
  **`git for-each-ref --format` は構造的に非翻訳**。コマンドを変えるほうが正しく、副作用
  (擬似行が消える・他の UI 文言を英語化しない)まで一緒に解決する
- **ref 一覧のパースは「名前の形」でなく構造で判定する**: `refs/heads/`・`refs/remotes/` の前置と
  `%(symref)` の有無で絞る。`%(refname:short)` は `refs/remotes/origin/HEAD` を `origin/HEAD` では
  なく **`origin`** に短縮するので `endsWith('/HEAD')` はすり抜ける。また `git branch -a --format`
  は detached HEAD に `(HEAD detached at 1a2b3c)` という **ref ではない行**を出す(いずれも実測)

## 6. 検証(隔離スモーク + 敵対的入力)

- 隔離環境の起動・後始末は [[pj-isolated-verify]] に従う(短パス推奨=罠 5)
- **最低セット**: happy path 1 + 代表エラー 1〜2 + 近傍回帰 1。破壊系はキャンセル経路も
- **E2E の穴を敵対的に埋める**: 正常系+想定エラー系が通っても、`-f` / `--exec=` / 先頭 `-` /
  配列・オブジェクト body などの敵対的入力は別途突く(unit green・E2E green でも別の網)
- 競合し得る操作(cherry-pick/revert/rebase/merge)は、競合→Phase 3 の operation バナー+
  競合解決 UI へ遷移して continue で完走 / abort で完全復元、の両経路を確認

## 7. brief に貼れるチェックリスト

- [ ] git.ts 薄い関数 / index.ts ルート / api.ts / types.ts 同期の 4 点
- [ ] hash は正規表現、自由入力は先頭 `-` 拒否 + **typeof を先に**(配列 body 対策)、400 は自前ラップ
- [ ] 検証ロジック(型・範囲・409/400 判定)は純関数に切り出し vitest で固定(supertest は入れない)
- [ ] operation && busy で disabled、既存の対称メニューと条件を突き合わせ
- [ ] 破壊系は ConfirmDialog(danger)+ 影響件数の正確な明示 + キャンセル無変更(許容判定は頻度でなく申告との一致で)
- [ ] `--follow` は `--name-status` + origPath 併用、自由入力検索は `--fixed-strings -i` + `=` 埋め込み単一トークン
- [ ] 隔離スモーク(happy + エラー + 敵対的入力 + 回帰)、pj-isolated-verify 参照
