# Harvest Log — pj-lsp-bridge

## 001: 言語サーバーは「スパイク → registry → session → 実機」の順で足し、サーバー固有の実測挙動を残す

- date: 2026-09-12
- context: Monaco の内蔵 TypeScript worker は開いているタブしか見えず、別ファイルの補完・定義
  ジャンプが効かなかった。自前の薄い LSP クライアント (素の JSON-RPC ブリッジ) で TypeScript を、
  続けて C# (Roslyn) を繋いだ 2 セッション分の実装・検証で、コードを読んでも分からない挙動が
  複数見つかった: この repo の TS は 7 で `tsserver.js` が無い / tsgo は最初の languageId で
  ファイル種別を固定する / Roslyn は 1 プロセス 1 ソリューションで、意味解析前の completion に
  null を返しその doc の補完が固定される / registerEditorOpener は peek で呼ばれない / 定義が
  自分自身だと Monaco が参照に落ちる / 隔離 home では NuGet が解決されない。
  ユーザー報告 2 件 (「F12 がファイル内の参照になる」= mode 未設定、「補完の文字が見えない」=
  グローバル `.main` の衝突) はいずれも LSP のコードではなく周辺の前提が原因だった。
- change: Why = LSP の不具合は「LS の実測挙動」「Monaco の登録タイミング」「検証環境の差」の
  どれかに帰着し、ブリッジのコードを読むだけでは切り分けられない。How = 足すときの順序とゲート、
  サーバーごとの罠、所有権と同期の不変条件、trace → 直叩きプローブ → スパイクの切り分け順、
  実機で必ず通す項目を 1 枚にした。Roslyn の completion null 対策は「固定秒数の保留」「hover の
  先送り」を試して大きいソリューションで効かず、「diagnostic pull の応答を待つ」に落ち着いた
  経緯を含めて記録した (再発時に同じ順で迷わないため)。
- supersedes: —
- result: (未記入 — 次に言語サーバーを足す/直すときに、この順序で迷わず済んだかを記録する)
