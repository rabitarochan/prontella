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

## 002: フェーズ 2 — 全文同期は close+open、申告外トリガーは Invoked、misc ファイルと上限の罠 (§2 / §4 / §6 改訂)

- date: 2026-09-13
- context: フェーズ 2 (診断・SignatureHelp・References・root 外ビューアー・C# UX・TS 既定 lsp) の
  スパイクと実機検証で、MVP に潜在していた不具合が 4 つ見つかった。(1) Roslyn は range 無しの
  全文 didChange で NullReferenceException を起こして落ちる — MVP の所有権移譲と isFlush の両経路が
  この形を送っていたが、実機で「外部変更の取り込み」を C# で試していなかったため気づかなかった。
  (2) tsgo は Monaco に登録した和集合の triggerCharacter (`(` `{`) を受けると -32603 panic を返す。
  (3) 60 秒に 3 回 kill → 手動再起動の後、死んでいる間に届いた didOpen が新プロセスに流れず
  補完も診断も空のままだった。(4) 上限 4 は同じセッションが 4 本を持つ限り LRU が効かず、
  5 つ目のソリューションが永久に unavailable になった。加えて、MSS3.sln が参照しない
  ディレクトリーのファイル (別コピー) は misc 扱いで hover が null になり、製品の不具合と
  見分けがつかなかった (スパイクの対象ファイル選定で 3 回無駄に回した)。
- change: §2 tsgo に「申告外 triggerCharacter → ready 後に initialize で申告を取り Invoked に落とす」
  「診断は pull のみ」を追加。§2 Roslyn に「全文 didChange で落ちる → session が didClose→didOpen に
  変換」「ソリューション外は misc」「shutdown は params 省略で正常応答 (MVP の .NET 例外の原因は
  params: null)」「上限 4 は docs 空のプロセスを LRU で落とす」「再 pull の実測時間」を追加。
  §4 に「全文は session が close+open に変換」「診断 pull だけ 300ms デバウンス・owner のみマーカー」
  「死んでいる間の didOpen は spawn 時 reset で開き直す」を追加。§6 の実機項目に診断・引数表示・
  参照・root 外・2 タイル・3 回 kill 後の復帰を追加。Why = MVP の「全文で送る」は正しい指示だったが
  「LS へそのまま流す」が Roslyn では致命的で、変換は経路が合流する session 層 1 箇所で行うのが
  最小。トリガー文字は Monaco の登録 (1 回・静的) と LS の申告 (プロセスごと) を分け、要求側で
  絞るのが「和集合を静的に渡す」設計を保ったまま panic を消す最小手。
- supersedes: — (001 の順序とゲートは維持。R5「shutdown で .NET 例外」の原因を訂正)
- result: 実機 (TS 隔離 4711 / C# 実 home 3799) で全項目を確認。修正後、外部変更の取り込み・
  2 タイル移譲の両方で Roslyn が生存し、3 回 kill → 再起動後に診断が戻ることをトレースで確認。
