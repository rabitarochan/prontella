# Harvest Log — pj-isolated-verify

## 001: 隔離検証手順の確立 (遡及エントリー)

- date: 2026-08-22
- context: 本スキルは harvest.md ペアモデル導入前に作られた。創設時の Why (USERPROFILE
  差し替えによる設定隔離・ポート分離・CDP 直叩き) と罠 1〜11 の実測経緯は SKILL.md 本文と
  git 履歴にある。本エントリーはログ起点の遡及記録。
- change: 既存の手順・罠 1〜11・フィクスチャ節を founding とみなす。
- supersedes: —
- result: 複数ミッションのスモーク・E2E 検証で常用されている。

## 002: Monaco 入力の第一候補を Input.insertText に変更 + DnD 合成検証を追加

- date: 2026-08-22
- context: エディターグループ分割 (feature/editor-groups) の E2E で、タイピング・タブ DnD・
  クロス leaf 転送を CDP で駆動する必要があった。罠 3 の旧記載 (Fiber + executeEdits) を
  使う前に「trusted click でフォーカス → Input.insertText」を試したところ、onChange →
  dirty → debounce の実経路がそのまま通った (31 項目 + 6 項目の E2E で使用)。
- change: 罠 3 を上書き — a11y ガードは MCP の type_text 系の話で、生 CDP の insertText は
  ブロックされない。Why: 実キーボードに近い経路で簡単。Fiber 法は複雑な編集用の代替に降格。
  併せて追加: (a) ストア駆動 DnD は untrusted DragEvent 合成で実経路検証できる
  (dragstart 後は React 再レンダー待ち必須)、(b) new-document スクリプトでの localStorage
  クリアは 1 回だけガード (毎回消すとリロード復元検証が自壊する — 実測で踏んだ)。
- supersedes: 001 (罠 3 の該当部分のみ)
- result: 修正後の本走行で実機 E2E 31/31 + プレビュー 6/6 PASS。

## 003: EditContext 版 Monaco の入力経路 + 打鍵単位再現 (罠 12) + cwd 後始末 (罠 13)

- date: 2026-08-22
- context: コンテキストメニュー拡充の隔離検証で 3 件を実測。(a) 同梱 Monaco が
  EditContext 版になり `textarea.inputarea` が消え、textarea 前提の注入
  (execCommand insertText) が全滅。MCP evaluate_script しか無い環境で Fiber 走査 +
  `editor.trigger('src','type')` により onChange → dirty の実経路を通した。
  (b) 「値の直接 set + Enter 合成」で検証した新規作成/リネーム入力に、react-arborist の
  タイプアヘッドがフォーカスを奪う不具合が潜んでおり、打鍵イベントを経由しない検証は
  これを再現できずユーザー報告で発覚した。(c) フィクスチャ削除が Device or resource busy
  で失敗 — 原因は Bash セッション自身の cwd 残留で、プロセス探索では見つからなかった。
- change: 罠 3 に EditContext 版の注意と Fiber 法の具体レシピ (fiber ルートまで遡上 →
  hooks 走査で getModel/executeEdits 保持値を拾う) を追記。罠 12 = 文字入力は打鍵
  イベント単位で、既存要素名と前方一致する文字を意図的に選ぶ。罠 13 = 後始末の rm は
  cwd を vt/ の外へ移してから。
- supersedes: 002 (罠 3 の textarea 前提の部分のみ — trusted click → insertText の
  優先順位自体は変えない)
- result: 打鍵単位の再検証でタイプアヘッド不具合の修正を確認 (press_key k/n/s)。
  cwd 退避後の後始末は同セッションで再発なし。

## 004: 状態リセットは flush に負ける — 「消してから navigate」を明示的に退ける (手順 5)

- date: 2026-08-22
- context: ファイルパネルの外部変更再読み込み機能の隔離検証で、テスト間のリセットに
  `localStorage.removeItem` + navigate を使い、偽の不合格を 3 件出した(前のテストが残した
  未保存 draft と分割済みグループが復活し続け、製品バグと誤認しかけた)。消去直後に
  キー数 0 を確認していたため、リセットは効いていると誤認したまま切り分けが長引いた。
  002 で `addScriptToEvaluateOnNewDocument` は既に登場していたが、「使うならガードを付けろ」
  という**注意書きの形**だったため、素朴な消去が原理的に効かないことに気づけなかった。
- change: 素朴な消去が効かない機構(離脱するページの unload flush が書き戻す)と、正しい
  順序(旧ページ flush → 新ドキュメントで消去 → アプリ起動)を先に述べ、new-document
  スクリプトを**第一の手段**に格上げ。1 回で外す規律は従属する注意として残す。加えて
  「リセットの成否はキー数でなく画面の実体で測る」「前提は通るのに本題が落ちる + 本文に
  前テストの痕跡、はフィクスチャ状態を疑う合図」を追加。
- supersedes: 002 (new-document スクリプトの位置づけのみ — ガード必須の内容は変えない)
- result: 手順どおりのリセットに切り替えたところ、同じテストが偽の不合格 3 件 → 全 7 件
  PASS に変わり、実 OS フォーカス経路まで含めて実機 54 チェック green を確認。

## 005: 実ユーザー環境が検証対象のときは USERPROFILE 隔離を外す (原理の例外) + 罠 14・15

- date: 2026-08-28
- context: ターミナルへの環境変数漏洩修正 (`pj-child-env`) の検証で、検証対象が
  「実 OS のユーザー環境変数から新規端末の環境を正しく再構成できているか」そのものだった。
  USERPROFILE を差し替えると `os.homedir()` だけでなく**再構成される env と PATH 自体が
  変わる**ため、001 の隔離手順をそのまま適用すると検証が対象を測れなくなる。
  実際には隔離せずポート分離 (3799) のみで検証し、事後に実データ側の残骸不在を確認した。
  併せて 2 つの偽の判定を踏んだ: (a) PTY 出力にマーカーを流して結果を回収する方式が、
  シェルのエコーで空の結果を掴み「全項目 OK・env キー 0 個」という偽 PASS を出した。
  (b) レジストリー PATH とプロセス PATH の単純比較で 38 要素の偽の欠落が出た。
- change: 原理に「実ユーザー環境そのものが検証対象なら USERPROFILE を差し替えない」例外を
  追加し、その場合の代替規律 (ポート分離の維持・実データ書き込み経路の事前洗い出し・
  事後の残骸確認・所見への明記) を定めた。Why: 隔離は目的ではなく手段であり、
  隔離が観測対象を変えてしまう検証では自己欺瞞になる。
  罠 14 = PTY マーカー回収をやめてファイル経由にする(不在確認の検証では空の結果が
  全項目 OK に化ける)。検証スクリプトはファイルに書いて実行する(heredoc と `node -e` が
  この環境で無音失敗する実測を含む)。罠 15 = PATH 比較は末尾 `\` を正規化するか
  `where.exe` で実解決を見る。
- supersedes: 001 (原理の「実設定に一切触れずに」を絶対条件としていた部分に例外を設ける。
  隔離が使える場合の手順そのものは変えない)
- result: 汚染 env から起動した実測で漏洩ゼロ・必須変数の到達・日本語値のバイト一致・
  コマンド解決・Agent SDK 疎通・フォールバックを確認。実データ側 (`~/.claude-deck3`) は
  agent-sessions に残骸なし、config.json は 19 リポジトリーで健全。
