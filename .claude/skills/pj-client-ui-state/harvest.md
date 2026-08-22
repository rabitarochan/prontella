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
