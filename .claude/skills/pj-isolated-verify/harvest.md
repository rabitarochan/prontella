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
