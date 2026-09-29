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

## 002: 2 つ目のアダプター (netcoredbg) で「1 つ目では見えない」前提が 3 つ割れた — 順序・大小文字・env

- date: 2026-09-29
- context: C# (netcoredbg、stdio) を js-debug の枠組みに足した。スパイク (d3-netcoredbg.mjs) で env 4 分岐・BP 行・
  後始末を測り、隔離 E2E と headless Chrome で確認した。割れた前提: (1) クライアントのハンドシェイク順序
  「setBreakpoints → configurationDone → launch」は js-debug では通るが netcoredbg では launch が永久に無応答
  (`Command execution timed out`)。VS Code の実際の順序 (launch を先に送り応答を待たない) だけが両方で通る。
  (2) `source.path` の相対化が小文字化した文字列から組んでいて `program.cs` になっていた — js-debug の応答は元から
  全小文字なので MVP の E2E では検出不能だった。(3) `DOTNET_ROOT` だけでは netcoredbg が動かず PATH の `dotnet` が要る
  (LSP の Roslyn は「両方要る」だったが、こちらは PATH だけが要る)。加えて `Expand-Archive` が読めない機体があり、
  bsdtar (`System32\tar.exe`) が zip も読むことで入手経路を 1 本にできた。
- change: §0 にアダプター表と transport、§1 に VS Code 順序のハンドシェイク、§2b に netcoredbg の罠、§4 に相対化の規則を追加。
  Why = 2 つ目のアダプターは「1 つ目で偶然通っていた前提」を炙り出す装置になる。順序・パス表記・env のような
  アダプター非依存に見える層ほど、実装は 1 つ目の癖に合わせて書かれている。判定は「両アダプターの E2E で同じ手順が通る」。
- supersedes: 001 の「配信バンドル確認」等は据え置き。001 の `result` 未記入欄はこの entry が埋める:
  「この順序で迷わず済んだか」→ スパイク → registry → launchConfig → session → E2E の順で迷わなかったが、
  ハンドシェイク順序はスパイクに項目が無く E2E で初めて出た (D2 に「configurationDone 前の launch」を必ず両順序で測る、を追加)
- result: 単体 41 件 green。隔離 E2E (C#) 23 項目 ×2 周 PASS。UI: ガター BP → `Program.Leaf()` で停止 → Locals に型付きの値 →
  ステップ → 続行で 2 回目の BP → 停止ボタン。実 home 無傷。
