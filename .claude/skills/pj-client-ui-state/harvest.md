# Harvest Log — pj-client-ui-state

## 001: 収録基準の確立 (遡及エントリー)

- date: 2026-08-22
- context: 本スキルは harvest.md ペアモデル導入前に作られた。創設時の Why は SKILL.md
  冒頭の「収録基準」(コードレビュー・ユニットテストで原理的に捕まらず実機で測って
  初めて分かった型だけを載せる) と git 履歴にある。本エントリーはログ起点の遡及記録。
- change: SKILL.md §0-§6 の既存内容を founding とみなす。
- supersedes: —
- result: エディター・ツリー・保存系の委任 brief で参照され、実機検証項目の設計に使われている。

## 002: Monaco Canceled 例外の型を追加 (§7)

- date: 2026-08-22
- context: エディターグループ分割 (feature/editor-groups) の隔離実機検証で、31 項目中
  コンソールエラー監視だけが FAIL。単体 447 テストと typecheck は green のまま漏れた。
  切り分けプローブで「アイドルの再マウントでは出ず、入力直後の分割/畳み込みでのみ
  Canceled 未処理拒否が出る」ことを特定した。
- change: Why = Monaco は dispose 時に in-flight 非同期を CancellationError で中断し、
  VS Code 本体もこれをエラー扱いしない。How = unhandledrejection を name/message 両一致の
  狭域フィルターで握る + 検証シナリオに「入力→即構造変更」を必ず入れる。
  代替案「グループ描画に host-div ポータル二層を導入して再マウント自体を無くす」は、
  被害がコンソールノイズのみでコストに見合わないため退けた (視覚被害が出たら再検討)。
- supersedes: —
- result: フィルター追加後の再走行で実機 E2E 31/31 PASS・コンソールエラーゼロを確認。

## 003: インライン入力とメニュー/ツリーのフォーカス衝突 2 型を追加 (§8, §9)

- date: 2026-08-22
- context: ファイルツリーのコンテキストメニュー拡充で、(a) メニューから開いたリネーム
  入力が非フォーカスのまま残る (隔離実機の activeElement 測定で発覚。typecheck・vitest は
  green)、(b) 新規作成/リネーム入力に文字が打てずタイプした文字で別行へフォーカスが飛ぶ
  (ユーザー不具合報告)。(b) の初回検証は値の直接 set + Enter 合成で行っており、keydown
  経路を通らなかったため再現せずに見逃した。
- change: §8 = Radix のクローズ時フォーカス処理が autoFocus に勝つ → ref +
  setTimeout(0) で 1 回だけ奪い返す。§9 = react-arborist コンテナーのタイプアヘッド検索が
  入力からのキーを拾い一致行へ DOM フォーカスを移す → 入力の onKeyDown で無条件
  stopPropagation。検証規律として「文字入力の再現は打鍵イベント単位で行う」を両項に付記。
- supersedes: —
- result: 隔離実機で、タイプアヘッド一致文字 (k/n/s) の実打鍵でも入力が保持され、
  作成・リネームとも成立することを press_key で確認済み。

## 004: 外部変更の取り込みで Editor を差し替えない / モデルは URI から引く (§10)

- date: 2026-08-22
- context: ファイルパネルに「ウィンドウ/タブがアクティブになったらディスクと突き合わせて
  再読み込みする」機能を追加した。ユーザー仕様は「画面は Loading」だったが、既存の
  `common.loading` プレースホルダー(`EditorGroupPane.tsx` の renderBody で `<Editor>` と
  排他)を流用すると Monaco がアンマウントされる経路になることが設計時に判明した。
  あわせて、応答を反映するとき `editor.getModel()` の URI 一致をガードにすると、
  タブから離れている間に応答が返った場合にモデルだけ取り残される穴が見つかった。
- change: §10 を追加。(a) 進行中表示は差し替えでなくオーバーレイ、150ms 遅延で明滅を
  避ける。(b) 反映先モデルは `monaco.editor.getModel(Uri)` で引き、URI 一致は viewState の
  保存/復元にだけ使う。既存の `reloadWithEncoding` は同一グループのアクティブタブ限定の
  ユーザー操作なので現状のままとし、**触っていない箇所は書き換えない**。
  代替案「Loading 中は入力を止める(オーバーレイで pointer-events を塞ぐ)」は退けた —
  入力があれば判定が apply から conflict へ倒れて編集が保護されるため、止める必要がない。
- supersedes: —
- result: 隔離実機で、スクロール位置は先頭行 23 → 23 のまま保持、700ms のレイテンシー注入
  時のみオーバーレイが出て通常は出ないこと、入力直後にチェックを撃っても入力が失われず
  新規コンソールエラーが 0 であることを確認(実機 54 チェック green)。
