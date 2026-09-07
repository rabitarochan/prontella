---
name: pj-child-env
description: >
  prontella で子プロセス (PTY ターミナル・Agent SDK・git・ripgrep・ファイルマネージャー) に
  渡す環境変数を組み立てる・変更する・spawn を新しく足すときの定石。2 系統の使い分け、
  deny-list が誤りである理由、Windows のレジストリーからの再構成規則、同期ウォームアップと
  フォールバック、汚染検証まで。env / process.env / spawn / PATH / NODE_ENV / node-pty /
  Agent SDK の env に触る実装・調査タスクを委任するとき、brief の References に
  このファイルのパスを入れる。
---

# pj-child-env — 子プロセスへ渡す環境変数 (prontella)

## Overview

deck の `process.env` をそのまま spawn に渡すと、**deck 自身が注入した変数**と
**deck を起動したシェル固有の変数**の両方が子プロセスへ漏れる。実害は大きい:
`NODE_ENV=production` はターミナル内の `npm install` に devDependencies を全削除させ
(このリポジトリーで 231 パッケージ消えた実績)、`PORT=3711` は dev サーバーに deck 自身の
ポートを掴ませ、`NO_COLOR` は色を消し、`GIT_EDITOR=true` は git の対話編集を無効化する。

env の構築点は `server/childEnv.ts` **1 箇所だけ**。他所で `{ ...process.env }` を
spawn に渡さない。

## 原理: 2 系統を使い分ける

| 系統 | 関数 | 基準となる env | 使う経路 |
|---|---|---|---|
| deck 内部ツール | `childEnv(extra?)` | deck が**起動時に継承した env のスナップショット** | `git.ts` / `search.ts` (ripgrep) / `index.ts` の reveal |
| ユーザーのコードが走る経路 | `terminalEnv(extra?)` | **OS で新規に端末を開いた相当**に再構成した env | `pty.ts` (PTY) / `agentSession.ts` (Agent SDK) |

Why 2 系統: 内部ツールは deck が動く前提の環境で動いてほしい(起動元シェル固有の PATH で
git を入れている環境を壊さない)。一方ユーザーのコードは、**deck をどの端末から起動したかで
挙動が変わってはいけない**。

`bin/prontella.js` は `process.env` を書き換える前に `captureInheritedEnv()` を呼ぶ。
この順序が `childEnv()` の正しさの前提なので、bin の先頭部分を編集するときは順序を壊さない。

## 決定則: deny-list で消してはいけない

「`NODE_ENV` と `PORT` を消せばよい」は**誤り**。deck が入れた値とユーザーが export した値を
区別できないため。全分岐に当てた真理値表 (2026-08-24 実測):

| 起動時のユーザー env | `--port` | bin が書く値 | 素の deny-list | スナップショット/再構成 |
|---|---|---|---|---|
| PORT なし | なし | `PORT=3711` | 除去 ✓ | 除去 ✓ |
| `PORT=5000` | なし | `PORT=5000` (同値を書き戻し) | **除去 ✗** ユーザー値を消す | 維持 ✓ |
| `PORT=5000` | `--port 4000` | `PORT=4000` | **除去 ✗** | 維持 ✓ |
| `NODE_ENV=development` | — | `??=` 不発 | **除去 ✗** | 維持 ✓ |
| NODE_ENV なし | — | `production` | 除去 ✓ | 除去 ✓ |

同じ理由で、再構成側も **「レジストリーに無い変数を全部引き継ぐ」= deny-list を採らない**。
実測ではプロセス env 80 個に対しレジストリー (Machine 27 + User 12) は 39 個で、差の 44 個には
`SystemRoot` `APPDATA` `USERPROFILE` 等の**必須系**と、`NO_COLOR` `GIT_EDITOR` `CLAUDECODE`
`CLAUDE_CODE_*` `PYTHONIOENCODING` 等の**起動元シェルの汚染**が混在している。
必須系を **allowlist で列挙**する (`WINDOWS_SESSION_VARS`)。

## Windows: レジストリーからの再構成規則

```
fresh = allowlist されたログオンセッション変数 (継承 env から)
        ⊕ Machine レジストリー env
        ⊕ User レジストリー env        (同名は User が勝つ)
        ⊕ PATH = Machine PATH + ';' + User PATH
```

実測で確かめた前提 (すべて 2026-08-24):

- `[Environment]::GetEnvironmentVariables('Machine')` は **REG_EXPAND_SZ を展開して返す**
  (`TEMP` が `%SystemRoot%\TEMP` ではなく `C:\WINDOWS\TEMP`)
- `Machine PATH + ';' + User PATH` の連結文字列が実プロセスの PATH に**完全一致で含まれる**
- レジストリー上の PATH のキー名は **`Path`**(`PATH` ではない)。Windows の環境変数名は
  大文字小文字を区別しないので、**照合も合成も case-insensitive で行う**

取得は PowerShell を 1 回起動して **Base64 で受け取る**。理由: コンソールのコードページに
依存せず UTF-8 バイト列をそのまま運べる(日本語を含む値が化けない)。スクリプト内に
二重引用符を入れないので `execFileSync` の引数エスケープでも壊れない。

## POSIX: ログインシェルからの再構成

`$SHELL -l -c 'env -0'` を 1 回実行し、NUL 区切りで解析する。profile/rc が組み立てた
本物のログイン環境が取れるので `SSH_AUTH_SOCK` (git over ssh に必須)・`LANG`・toolchain の
PATH が正しく入る。渡す側の env は POSIX 用 allowlist + ブートストラップ PATH のみ。

**PTY のシェル起動引数は変えない**(非ログイン対話シェルのまま)。env がすでにログイン環境
なので、`-l` を足すと profile が二重に走る。

> 2026-08-28 時点、POSIX 経路は実行環境が無く**未検証**。純関数 `parseEnvNul` の単体テストのみ。
> macOS/Linux で動かす機会があれば、まず `terminalEnv().PATH` と `SSH_AUTH_SOCK` を実測すること。

## 実装上の制約

- **同期 + 起動時ウォームアップ**にする。`PtyManager.create()` が同期関数なので、非同期
  キャッシュにすると「起動直後の 1 本目だけフォールバック env」というレースが生まれる。
  `warmTerminalEnv()` を `new PtyManager()` より前で呼ぶ
- コストは実測 **約 2 秒**(PowerShell 5.1 の起動が支配的)。タイムアウトは 10 秒
- **失敗時は必ず継承 env にフォールバックして警告を出す**。ターミナルが開けない事態を作らない。
  `warmed` フラグで再試行しない(毎回 10 秒待つ事故を防ぐ)
- Agent SDK の `Options.env` は **設定すると環境を完全置換する**(`process.env` とマージしない)。
  `terminalEnv()` はフルセットを返すのでそのまま渡してよいが、部分的な env を渡してはいけない

## 新しい spawn を足すときの手順

1. その子プロセスが **deck 内部ツール**か **ユーザーのコードが走る経路**かを決める
2. `childEnv({...})` / `terminalEnv({...})` のどちらかを `env:` に渡す。
   固有の変数は第 1 引数の extra で足す(extra が勝つ)
3. `process.env` を直接読んでいないか確認する。読むなら同じ系統の関数から取る
   (例: `pty.ts` の `defaultShell()` は `terminalEnv().SHELL`)
4. **PATH から解決した実行ファイルの拡張子を見る**。`.cmd` / `.bat` ならそのまま
   spawn できない(下記の決定則)
5. 汚染検証(下記)を回す

## 決定則: Windows で `.cmd` / `.bat` は spawn できない — ラッパーの実体まで降りる

`PATH` から解決した実行ファイルが `.cmd` / `.bat` だったら、**そのまま `spawn` してはいけない**。
Node は CVE-2024-27980 (Windows のコマンドインジェクション) 対策以降、`shell` 無しでの
`.cmd` / `.bat` 起動を拒否し **`spawn EINVAL`** で落ちる。`ENOENT` ではないので
「PATH に無い」と読み違えやすい。`windowsExecutableCandidates()` の PATHEXT 走査は
`.CMD` も候補に含むため、**PATH 解決が成功した直後にここで落ちる**。

**`shell: true` で逃げない。** cmd.exe に渡す文字列になるので、`C:\Program Files\...` の
ような空白入りパスやブランチ名の記号がクォート事故に化ける。ここは引数インジェクションの
入口でもある(`pj-git-route` の防壁と同じ扱い)。

打ち手: **`.cmd` は薄いラッパーでしかないので、それが起動している実体を自分で解決する。**

- `<root>/bin/code.cmd` → `<root>/Code.exe`。VS Code / VSCodium / Cursor は同じ配置なので
  候補名を順に `existsSync` で試す。**見つからなければ元の値に戻す** — 解決に失敗しても
  壊さない (`server/editorLaunch.ts` の `nativeAppFor()` が実装例)
- `.cmd` の中身を読むのが最も確実。実測した `bin/codium-server.cmd` は
  `"%ROOT_DIR%\node.exe" "%ROOT_DIR%\out\server-main.js" %RESTVAR%` の薄いラッパーだったので、
  **同梱 `node.exe` + スクリプトを直接 spawn する**形にした。副次的に、ユーザー側の
  Node バージョンにも依存しなくなる
- macOS は逆に `code` が PATH に無い環境があるので `open -a "Visual Studio Code"` を
  フォールバックに置く。POSIX は `spawn` に PATH 解決を任せてよい(シェルを介さないため)

**検証**: 「押してもエラーが出ない」を合格にしない。GUI アプリの fire-and-forget 起動は
`detached` + `child.on('error', () => {})` で例外を握り潰すのが定石なので、**EINVAL は
画面にもログにも出ない**。実際にアプリが目的のフォルダーで開くところまで見る。

## 決定則: 再構成で失われた「能力」を env で取り返さない

allowlist 再構成は変数を落とすだけでなく、**起動元シェル由来だった機能を静かに消す**。
実例 (2026-09-01): PTY の `PSModulePath` が継承から再構成に変わり、PS7 のモジュールパス
3 本が消えた。deck の Windows 既定シェルは `powershell.exe` (5.1) なので、それまでは
deck を pwsh から起動したときだけ 5.1 が **PS7 同梱の PSReadLine 2.4.5** を拾っていた。
再構成後は 5.1 同梱の **2.0.0** に戻り、**予測入力 (Predictive IntelliSense) が消えた**
(2.0.0 には `-PredictionSource` パラメーターが無い)。

判断の順序を固定する:

1. **素の端末を開いた状態と一致するかを測る**。一致していれば再構成は正しい。
   上の例では、エクスプローラーから開いた `powershell.exe` も同じ 3 本だった =
   失われたのは「deck を pwsh から起動したときだけ効く偶然」でしかない
2. 一致しているなら **env を戻さない**。直すのは env ではなく、その能力を提供する側の設定
   (上の例では**シェルの選択**。`pty.ts` の `defaultShell()` を pwsh 優先にした)
3. 一致していないなら allowlist の不足なので `WINDOWS_SESSION_VARS` に足す

Why この順序: env を戻すと「deck をどの端末から起動したかで挙動が変わってはいけない」という
2 系統の前提そのものが崩れる。**症状が消えることと原因が正しいことは別**で、
継承へ戻す修正は前者しか満たさない。

## 落とし穴 (実測)

- **PATH 系の変数は順序が意味を持つ**。`PSModulePath` は先勝ちで、同じモジュールの
  別バージョンが複数のパスにあると**並び順だけで解決結果が変わる**。値の集合が同じでも
  順序が違えば別環境なので、比較も再現も順序込みで行う
- **レジストリー由来の PATH 要素は末尾に `\` が付く**。プロセスの PATH と単純文字列比較すると
  「`C:\Program Files\dotnet\` が欠落した」と**偽陽性**が出る。比較するなら末尾を正規化するか、
  `where.exe` で実際に解決できるかを見る
- **Volta は実行時に自分で PATH を足す**。ターミナル内の `node` が見る PATH に
  `Volta\tools\image\node\<ver>` が入っていても漏洩ではない
- `process.env.ANTHROPIC_API_KEY` のような**判定も、実際に渡す env で行う**。
  渡す env と判定する env がズレると誤検知・見落としになる

## 検証

**汚染した env から deck を起動して、漏れていないことを実測する**。継承 env で起動して
「入っていない」を確認しても、もともと入っていなかっただけかもしれない。

```sh
DECK_LEAK_PROBE=leaked NO_COLOR=1 GIT_EDITOR=true CLAUDECODE=1 \
  node bin/prontella.js --port 3799 --no-open
```

確認項目:

1. **漏れていないこと**: `NODE_ENV` `PORT` `NO_COLOR` `GIT_EDITOR` `GIT_ASKPASS`
   `CLAUDECODE` `DECK_LEAK_PROBE`
2. **届いていること**: `PRONTELLA_PORT` / `PRONTELLA_TERM`(hooks 検知が依存)、
   `APPDATA` `SystemRoot` `USERPROFILE` `TEMP` `Path` `PATHEXT` `ComSpec`
3. **OS 側の設定が届くこと**: `[Environment]::SetEnvironmentVariable('X','1','User')` を
   設定 → deck 再起動 → ターミナルに届く(**確認後に必ず削除する**)
4. **エンコーディング**: 日本語を含むユーザー環境変数を設定し、ターミナル内で
   `Buffer.from(v,'utf8').toString('hex')` が期待バイト列と一致すること
5. **コマンド解決**: fresh env で `git` `node` `npm` `npx` `claude` が `where.exe` で解決できること
   (`claude` が落ちると「✦ Claude 起動」が壊れる)
6. **フォールバック**: 一次取得を失敗させて(PATH から `powershell.exe` を消す等)、
   警告が出たうえでターミナルが開けること
7. **Agent SDK**: チャットセッションを 1 本立てて応答が返ること(env 完全置換の影響確認)
8. **能力が同じこと**(変数名の有無だけでは足りない): ターミナルで**使えていた機能**が
   使えるか。最低限、**シェルの実体** (`[System.Diagnostics.Process]::GetCurrentProcess()
   .MainModule.FileName`) と、**そこに解決されるモジュールの版**
   (`(Get-Module PSReadLine).Version` / `Get-Module -ListAvailable` の先頭) を、
   素の端末を開いた場合と突き合わせる。**環境変数の一覧が揃っていても、順序が違うだけで
   別のモジュールが読まれて機能が消える**(2026-09-01 に予測入力で実際に起きた)。
   対話でしか決まらない既定値があるので、判定は非対話実行ではなく実 PTY で行う
   (`pj-isolated-verify` 罠 25)

ターミナル内の env の回収方法と隔離の注意は `pj-isolated-verify` を参照
(**PTY 出力からマーカーで回収すると偽 PASS が出る** — 罠 14)。
