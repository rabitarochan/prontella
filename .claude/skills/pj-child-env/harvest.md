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
