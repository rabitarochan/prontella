# Harvest Log — pj-metrics-instrument

## 001: 2 層 (anon/dev) のメトリクス収集を、閉じた allowlist とハンドル方式で入れる

- date: 2026-09-09
- context: ユーザーが「どの処理が遅いか・メモリ・リーク・ハング・ムダな処理を実データで見て AI と
  協働改善したい」と発注。案は「匿名 (エンドユーザー) と開発用 (自分) の 2 層」。収集先は
  インフラ・規約・README の「外部通信なし」の前提から**ローカル保存 + 手動エクスポート**、匿名層は
  **既定 OFF**、分析の入口は **JSONL + summarize CLI** をユーザーが選択。実装中に (1) 形状の正規表現で
  ルートを許すと base64url の repo id が素通りする、(2) `monitorEventLoopDelay` は 20ms で CPU 1.4%
  かつ値に分解能の下駄が乗る、(3) Worker は存在だけで 0.4%、(4) `express.json` の後ろでは 413 が
  観測できない、(5) dev の常時 rAF ループが bench でページ TaskDuration +17〜31%、の 5 点が実測で出た。
- change: Why — 匿名性は「危険な文字列を探す」blocklist ではなく「許された形以外は落とす」allowlist で
  なければ追加漏れが漏洩になる。負荷は「off なら分岐 1 つ」「ホットパスは整数加算」「I/O は定期 snapshot」
  でなければ性能ツール自身が性能を落とす。How — `names.ts` を語彙の唯一のソースに、`ROUTES` を閉じた列挙 +
  `server/index.ts` との突合テスト、ELD は dev 50 / anon 100ms で分解能を差し引く、watchdog Worker は
  dev 専用、HTTP ミドルウェアは `express.json` の前、rAF は 1 秒ごとの単発プローブ。
  **却下した代替**: ルートの形状正規表現 (穴が実証された)、常時 rAF ループ (負荷)、
  anon での attrs 部分削除 (削り忘れが漏洩になる → レコードごと落とす)。
- supersedes: —
- result: bench 3 ペアでサーバー node CPU は dev ≤ off (測定不能)、クライアントは rAF プローブ化後に
  off の最良値と同水準。隔離ブラウザー検証 15/15、全体テスト 848 件通過。
