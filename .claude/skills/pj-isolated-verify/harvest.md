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
