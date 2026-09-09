---
name: pj-metrics-instrument
description: prontella のメトリクス収集 (server/metrics・client/src/metrics・scripts/metrics) に計測点を足す・語彙を増やす・集計を読む・負荷を測るときの定石。off/anon/dev の 3 tier、匿名層の閉じた allowlist (names.ts が唯一のソース)、ホットパスのハンドル方式、monitorEventLoopDelay の下駄と Worker のコスト、bench A/B の読み方まで。metrics / counter / span / histogram / PRONTELLA_METRICS / summarize.mjs / scrub / names.ts / 計測 / 性能調査 / メモリリーク / ハング検知 に触る実装・調査タスクを委任するとき、brief の References にこのファイルのパスを入れる。
---

# pj-metrics-instrument — メトリクス計測点の足し方と読み方 (prontella)

## 収録基準

2026-09-09 の初回実装で **実測して決まった数値** と **判別器を実データに当てて崩れた設計** だけを載せる。
設計全体は `~/.claude/plans/elegant-toasting-rain.md` (計画) と README の Notes に、
検証手順は `scripts/metrics/browser-check.mjs` にある。

## 1. 構造 (触る前に知っておく 4 点)

- **tier の権威はサーバー**: `PRONTELLA_METRICS` (env、API から変更不可 = locked) > `config.json` の
  `metrics.tier` > `off`。`dev` は env か config.json 手編集でしか有効にならない。クライアントは起動時に
  `GET /api/metrics/config` を 1 回引くだけ。**クライアントが送ってきた記録もサーバーの tier で整形する**
  (`writeRecord` → `checkAnon`)。クライアントを信用して匿名性を決めない
- **レジストリは常に 1 つ** (`server/metrics/index.ts` の `metrics`、client は `client/src/metrics/core.ts`)。
  tier 切替は `enabled` と sink/sampler を差し替えるだけなので、**計測点はモジュール読み込み時にハンドルを取ってよい**
  (`const M = { flush: metrics.counter('pty.flush') }`)。off の間は `add()` が分岐 1 つで抜ける
- **書き込み経路は 2 つだけ**: 定期 `snapshot` (dev 5 秒 / anon 30 秒。カウンター累積・ゲージ最新値・
  ヒストグラム区間要約) と、稀な `event` (slow / hang / stall / ws / session / self)。
  ホットパスで event を出さない — 出すなら slow しきい値 (`slowMs`) を通す
- **クライアントの計測点は `client/src/metrics/core.ts` だけを import する**。`index.ts` は zustand /
  monaco / DOM オブザーバーを引き込むので、`api.ts` や `store.ts` のような単体テストされるモジュールから
  import すると vitest が monaco を読みに行く

## 2. 計測点を足す手順

1. **名前とラベルを `server/metrics/names.ts` に登録する** (`METRIC_NAMES`、ラベル値は `STRING_RULES` の語彙)。
   登録しないと anon では**レコードごと落ちる** (漏洩ではなく欠測になる設計)。
   動的な部分は名前に入れずラベルに出す (`sdk.msg {sdk: 'assistant'}`、`ws.frames.in {path: '/ws/term'}`)
2. **ホットパス** (PTY の onData/flush、xterm の write、liveSocket の onmessage) は
   `metrics.counter(name, labels)` のハンドルを 1 回取り、`add(n)` だけ呼ぶ。
   `metrics.count(name, 1, labels)` は毎回ラベルの文字列連結 + Map 引きなので、毎フレーム/毎チャンクの場所では使わない
3. **時間は span**: `const end = metrics.startSpan('git', { git: sub }, { cwd, args })` → `end()` / `end({ err: true })`。
   第 2 引数 (labels) は語彙内の文字列のみ、第 3 引数 (attrs) は自由形式で **dev 層でしか付かない**
   (`includeAttrs`)。決着点が複数ある非同期処理は `settled` を立てる場所で 1 回だけ終える
   (`runGitInput` は 4 か所)
4. **自由形式の付帯情報は `event(kind, fields, devFields)` の第 3 引数へ**。第 2 引数に cwd や sid を
   入れると anon でレコードごと落ちる
5. **HTTP ルートを足したら `ROUTES` にも足す**。`names.test.ts` が `server/index.ts` の
   `app.<method>('/api/...')` と突き合わせて落ちる — テストが教えてくれるので先回りしなくてよいが、
   落ちた理由を「テストが古い」と誤読しない
6. 集計に載せたいなら `scripts/metrics/lib/analyze.mjs` の `waste` / `hangs` にも 1 行足し、
   `server/metrics/summarize.test.ts` の合成レコードに期待値を追加する

## 3. 判別器の教訓 (実データに当てて崩れたもの)

- **ルート名を形状の正規表現で許すと、base64url の repo id が素通りする**
  (`/api/repos/QzpcVXNlcnNcYWxpY2U` は `[A-Za-z0-9_-]+` に一致する)。`req.route.path` だけを使えば
  テンプレートしか来ないが、防御を「呼び出し側の正しさ」に頼らず、**`ROUTES` を閉じた列挙**にした。
  scrub.test.ts の `path-like route` ケースがこの穴の再発を止める
- **`req.url` / `req.originalUrl` を絶対に記録しない**。クエリに `dir=C:\...` が入る。
  未確定ルートの分類 (`unmatched` / `static`) は prefix の判定に使うだけで値を出さない
- **匿名層の検査は変換しない** (`scrubAnon` は合格したレコードを同一参照で返す)。部分的に削って書くと
  「削り忘れ」が漏洩になる。丸ごと落として `metrics.self.scrubDropped` に計上する
- **陰性対照を必ず固定する**: 正当な snapshot / slow / session が無傷で通ることを scrub.test.ts に置いている。
  「全部落とす判別器」は陽性側のテストだけなら合格してしまう

## 4. 実測で決まった数値 (2026-09-09、このマシン)

| 項目 | 実測 | 採用 |
|---|---|---|
| `monitorEventLoopDelay` 分解能 20ms | CPU 1.36% (単体で予算 1% 超) | **dev 50ms / anon 100ms** (50 以上は 0%) |
| 同 API の値 | **分解能ぶんの下駄が乗る** (300ms ブロックで max 348、アイドルで min ≈ 分解能) | sampler が `resolution` を差し引く |
| worker_threads の Worker | 中で何もしなくても **存在だけで約 0.4%** | watchdog は **dev 専用** |
| `process.cpuUsage` の粒度 | 15.6ms 刻み | 短時間の比較は比で見る、絶対値を信じない |
| 常時 rAF ループ (dev) | bench でページ TaskDuration +17〜31% | **1 秒ごとの単発 rAF 遅延プローブ**に置換 → off と同水準 |
| HTTP 計測ミドルウェアの位置 | `express.json` の後ろでは body-parser の 413 が観測できない | **`express.json` より前** |
| `sendBeacon` の `application/json` Blob | `express.json` がそのまま解釈 (headless Chrome で実測) | 離脱時のバッチに採用 |
| `performance.memory` | 対象 Chrome に存在 | `js.heap.used/total` ゲージ (無ければ記録しない) |

## 5. 負荷ゲート (bench A/B) の回し方と読み方

- `PRONTELLA_METRICS=off|dev node scripts/bench/term-bench.mjs --label metrics-<tier>-<n> --sessions 6 --seconds 20`。
  bench は `process.env` を隔離サーバーへ継承する (`scripts/bench/lib/server.mjs`)。JSONL は
  `vt/bench-*/home/.prontella/metrics/` に落ちて後始末される
- **off/dev をペアで交互に回す** (1 ペア ≈ 6 分。Bash ツールの 10 分上限があるので 1 呼び出し 1 ペア)。
  3 ペアで判断し、**サーバーは node の CPU 秒、クライアントはページ B (モニター) の TaskDuration** を比で見る。
  run ごとのばらつきは off だけでも 2 倍あるので、1 ペアの差で結論を出さない
- ハーネスの「M2 出力の静止待ち 70 秒」タイムアウトは計測と無関係の既知ノイズ。後始末で
  `vt/bench-metrics-*` が残ることがある — 自分の分だけ消す

## 6. 読む側 (AI と協働するとき)

- `node scripts/metrics/summarize.mjs --tier dev [--since 2h] [--run <id>]` の Markdown を読ませる。
  順番は「遅い処理 → メモリ傾き (MB/h, R²) → ハング/ストール (帰属 + 直近 span) → ムダな処理 → 自己コスト」
- カウンターは**累積** (run の最後の snapshot を使う)、ヒストグラムは**区間** (snapshot ごとに合算する)。
  `linearFit` は epoch ms を平均で中心化してから計算する (そのままだと桁落ちで傾きが 1e-5 ずれる)
- 判別器の閾値: 傾き > 20MB/h かつ R² > 0.6 で「増加」、`canvas/xterm` > 2 でリーク疑い、
  同 path の reconnecting が 10 秒に 3 回以上でストーム。これらは `summarize.test.ts` の合成データで
  陽性/陰性を固定している — 閾値を変えるならそこも変える

## 7. 検証

- 単体: `npx vitest run server/metrics client/src/metrics`
- ブラウザー経路 (ingest / beacon / route テンプレート / export / 検証拒否): `npm run build && node scripts/metrics/browser-check.mjs`
  (隔離ホーム + headless Chrome、15 チェック)。**`/ws/events` は `bootMetrics()` の fetch より先に開く**ので
  初回の `open` 相転移は数えない — 再接続だけが対象
- 実ホームは触らない。終了後に `~/.prontella/hook-settings.json` のポートが本番のままか、
  `~/.prontella/metrics/` が存在しない (tier off) かを確認して報告する ([[pj-isolated-verify]] 罠 24)
