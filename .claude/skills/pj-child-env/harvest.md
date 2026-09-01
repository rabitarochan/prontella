# Harvest Log — pj-child-env

## 001: 子プロセス env を 2 系統に分け、OS 既定環境を再構成する

- date: 2026-08-28
- context: ターミナルパネルで開いた端末に `NODE_ENV=production` が設定されている、という
  ユーザー報告から。実測すると OS の User/Machine スコープにも PowerShell プロファイルにも
  `NODE_ENV` は無く、`bin/claude-deck.js` が自プロセスの `process.env` に `PORT`/`NODE_ENV` を
  書き、`server/pty.ts` が `{...process.env}` を PTY へ丸ごと渡していたのが原因だった。
  さらに調べると、漏れていたのはその 2 変数だけではなく、deck の起動元シェル由来の
  `NO_COLOR` / `GIT_EDITOR` / `CLAUDECODE` 等 44 個が混入していた。
  当初案は「起動前スナップショットを子 env の基準にする」だったが、ユーザーの
  「pty.ts にて、claude-deck を起動した際の env ではなく、新規に起動したターミナルの環境は
  作れないの?」という指摘で、起動元非依存の再構成へ設計を変更した。
- change: `server/childEnv.ts` を新設し唯一の env 構築点とする。内部ツールは
  `childEnv()` (起動前スナップショット)、ユーザーのコードが走る経路は `terminalEnv()`
  (Windows はレジストリー再構成 / POSIX はログインシェル取得) を使う。
  **却下した代替: deny-list で `NODE_ENV`/`PORT` を消す方式** — 全 5 分岐の真理値表を作った
  ところ 3 分岐で誤動作する(ユーザーが自分で export した `PORT=5000` や
  `NODE_ENV=development` まで消す)。同じ理由で「レジストリーに無い変数を全部引き継ぐ」も
  却下し、ログオンセッション変数は allowlist で列挙する。
  Why: deck が入れた値とユーザーが持っていた値は、値だけを見ても区別できない。
- supersedes: —
- result: 汚染 env から起動した実測で漏洩ゼロ / 必須変数と `CLAUDE_DECK_*` の到達 /
  日本語値のバイト一致 / `git` `node` `npm` `npx` `claude` の PATH 解決 /
  Agent SDK の 1 往復 / フォールバック動作 をすべて確認。`npm test` 567 件 green。
  POSIX 経路は実行環境が無く未検証のまま。

## 002: 再構成で失われた「能力」を env で取り返さない (決定則 + 落とし穴 + 検証 8)

- date: 2026-09-01
- context: ユーザーから「ターミナルで PowerShell の予測入力 (グレー文字の履歴補完) が
  出なくなった」と報告があり、直近の split 機能か env 対応のどちらかが疑われた。
  git で確認すると split は `pty.ts` / `childEnv.ts` を触っておらず、原因は 001 の
  env 対応 (6fc1612) の副作用だった。deck の Windows 既定シェルは初回コミット以来
  `powershell.exe` (5.1) で、5.1 同梱の PSReadLine は 2.0.0 = 予測入力が未実装。
  6fc1612 より前は PTY が deck の env を継承しており、deck を pwsh から起動していると
  `PSModulePath` の**先頭**に PS7 のモジュールパスが並ぶため、5.1 が PS7 同梱の
  PSReadLine 2.4.5 を拾って予測が効いていた。terminalEnv() が PSModulePath を
  レジストリーから再構成した結果その 3 本が落ち、2.0.0 に戻った。
  つまり「変数が漏れていないか」だけを見る検証項目 (001 で作った 1-7) では、
  **落ちたのが変数ではなく能力だったため素通りした**。
- change: 「再構成で失われた能力を env で取り返さない」決定則、PATH 系変数の順序に関する
  落とし穴、検証項目 8 (能力の同一性) を追加。Why = allowlist 再構成は変数を落とすだけでなく
  起動元シェル由来の機能を静かに消す。しかもその消え方は**症状 (予測が出ない) と原因
  (PSModulePath の 3 本) が 4 ホップ離れている**ので、変数一覧の突き合わせでは見つからない。
  How = ①素の端末を開いた状態と一致するかを先に測る ②一致していれば再構成は正しいので
  env は戻さず、能力を提供する側 (シェルの選択) を直す ③一致していなければ allowlist の不足。
  実際に `defaultShell()` を pwsh 優先へ変更して解決した (f1ac369)。
  **代替案「PSModulePath を allowlist / 継承に戻す」は退けた** — 素の powershell.exe を
  開いても再構成後と同じ 3 本になるので再構成は正しく、戻すと「deck をどの端末から起動しても
  中身が変わらない」という 001 の前提そのものが壊れる。症状は消えるが原因は直らない。
  **代替案「5.1 のまま新しい PSReadLine を入れてもらう」も退けた (既定としては)** —
  ユーザー側の環境構築に依存し、他の環境では再発する。README には回避策として残した。
- supersedes: —
- result: deck の PTY で対話状態を実測した真理値表で確認: 変更前相当 (5.1 + 2.4.5 =
  PredictionSource:History) → 修正前 (5.1 + 2.0.0 = パラメーター自体が無い) → 修正後
  (pwsh 7.6.5 + 2.4.5 = HistoryAndPlugin/InlineView)。`CLAUDE_DECK_SHELL` による
  opt-out と、解決できない値での警告つきフォールバックも実測。
