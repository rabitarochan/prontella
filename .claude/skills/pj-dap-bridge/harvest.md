# Harvest Log — pj-dap-bridge

## 001: デバッグアダプターは「スパイク → registry → launchConfig → session → 隔離 E2E」の順で足し、js-debug 固有の実測挙動を残す

- date: 2026-09-29
- context: TS / C# の LSP ブリッジに続き、DAP (vscode-js-debug) で Node/TS のデバッガーを 1 セッションで実装した。
  スパイク (D1〜D10) と実装後の隔離 E2E で、コードを読んでも分からない挙動が多数見つかった:
  dapDebugServer は TCP で root 接続はランチャー、実ターゲットは `startDebugging` → 別接続で子に BP を送らないと止まらない /
  `type:"node"` は素の DAP サーバーが知らず launch が永久に無応答 (VS Code が拡張で `pwa-node` に読み替えている) /
  tarball に package.json が無く ESM 配下で即死 / PATH の GNU tar が `C:` をリモート扱い / `terminalEnv()` に node が無い (mise) /
  アダプターは 1 実行が終わっても自分で終わらず、閉じ忘れると再開始が空振り / `source.name` にも絶対パスが入り
  起動コマンド行が output で流れる / 隔離 home に `AppData\Local\Temp` が無いと js-debug が即死 (環境起因)。
  さらに「終了後に再開始できない」は修正後にビルドしていない古いバンドルの検証で、製品バグと誤認しかけた。
- change: Why = DAP の不具合は「アダプターの実測挙動」「VS Code が拡張側で補っている値」「入手・env の環境差」
  「検証環境の差」のどれかに帰着し、ブリッジのコードを読むだけでは切り分けられない (LSP と同じ構図)。
  How = 足す順序、js-debug の罠、入手と env の罠、ワイヤー/パス/装飾の不変条件、隔離 E2E で必ず通す項目と
  環境起因の偽陰性を 1 枚にした。設計判断 (クライアントは launch 本体を送らない、多重化は `sessionId`、後始末は
  disconnect → 1 s で kill、BP は要求順対応付け) は `docs/debug-mvp-plan.md` に置き、ここは再発時の判断材料に絞った。
- supersedes: —
- result: 単体 66 files / 1098 tests green。隔離 E2E: `/ws/debug` 直叩き 31 項目 ×2 周 全 PASS、headless Chrome (CDP) で
  ガタークリック → 停止 → ステップ → 別ファイルへ着地 → REPL → 終了 → 再開始 → リロード後の BP 復元まで確認。
  実 home 無傷、残骸プロセス無し。(未記入 — 次にアダプターを足す (netcoredbg) ときに、この順序で迷わず済んだかを記録する)
