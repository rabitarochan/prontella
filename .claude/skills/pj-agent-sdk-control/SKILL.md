---
name: pj-agent-sdk-control
description: >
  claude-deck3 で Agent SDK の control request (supportedCommands / supportedModels /
  usage_EXPERIMENTAL_* 等、プロンプトを送らずに Query から引くデータ) を使って
  サーバー側に機能を足すときの定石。Query の寿命設計 (常駐 1 本 + single-flight +
  TTL)、EXPERIMENTAL API の縮退規律、型定義より広い実ペイロードの扱い、実資格情報が
  要る機能の検証の切り分けまで。@anthropic-ai/claude-agent-sdk / query() / Query /
  usage / rate limit / 使用量 / supportedModels / supportedCommands / control request /
  sdk.d.ts に触る実装・調査タスクを委任するとき、brief の References にこのファイルの
  パスを入れる。
---

# pj-agent-sdk-control — Agent SDK の control request で機能を作る定石(claude-deck3)

## 収録基準

**型定義とドキュメントを読んだだけでは分からず、実際に叩いて初めて分かった型**だけを載せる。
SDK の一般的な使い方 (query の呼び方・メッセージの流し方) は載せない。
1 項目は「機構 → 打ち手」で 10 行以内。

## 0. 経路の切り分け — hook と control request は別物

claude-deck3 が Claude から情報を得る経路は 2 つあり、**設計上の制約がまったく違う**。

| | hook (`/api/hooks/*`) | control request (`Query` のメソッド) |
| --- | --- | --- |
| 向き | Claude → deck の**プッシュ** | deck → Claude の**プル** |
| 対象 | エージェントの実行状態・ツール・サブエージェント | コマンド一覧・モデル一覧・使用量 |
| 前提 | `--settings` 注入済みの PTY セッション | **生きている `Query` オブジェクト 1 つ** |
| 定石 | [[pj-agent-status-detect]] | このスキル |

**「エージェントが今何をしているか」は hook、「アカウント/CLI が持っている静的〜準静的な
データ」は control request**。混同すると、hook が届かないセッション (素のシェル) を
永久に待つ実装や、逆に control request を毎ターン叩く実装になる。

## 1. control request は「プロンプトを 1 通も送らずに」呼べる — Query の寿命はこれで決まる

- **機構**: `query({ prompt, options })` は**最初の入力メッセージまで CLI の起動を遅延する**が、
  control request を投げると**そこで起動する**。したがって「解決しない AsyncIterable を prompt に
  渡した Query」に対して `supportedCommands()` / `supportedModels()` /
  `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` を呼べる。
  **モデル呼び出しは走らないのでトークンは消費しない**
  (`agentSession.ts` の create が同じことを「CLI の先行ウォームアップ」として既にやっている)
- **コストの実測 (2026-08-30、usage で計測)**: **初回 14.2 秒 / 2 回目 2.8 秒 / 3 回目 1.9 秒**。
  初回のほぼ全部が CLI の起動。**毎回 spawn すると毎回 14 秒**
- **打ち手**: チャットと無関係にデータが要る機能は、**専用の Query を 1 本だけ遅延生成して
  常駐させる**。そのうえで **TTL キャッシュ + single-flight** (同時呼び出しを 1 本に束ねる) を
  必ず付ける — 初回が十数秒かかるので、束ねないと起動が多重に走る (`server/usage.ts` が実装例)
- **プロセスが死んだら次回作り直す**。control request が reject したら Query を捨て、
  **指数バックオフ**で再試行する。落ちたまま毎回 14 秒待たされる方が実害が大きい

## 2. EXPERIMENTAL な API は 1 ファイルに閉じ、失敗を「機能なし」へ縮退させる

- **機構**: `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` の名前どおり、
  **メソッド名も戻り値の shape も予告なく変わる/消える**。SDK のバージョンを上げただけで
  `TypeError: fn is not a function` になりうる
- **打ち手**: 呼び出しを 1 モジュールに閉じ、**3 つの失敗をすべて同じ「利用不可」へ畳む** —
  ①例外 ②`typeof q.<method> !== 'function'` (SDK 未対応) ③データとしての不成立
  (`rate_limits_available === false` = API キー運用 / Bedrock / Vertex)。
  API は **200 + `available: false`** で返し、**500 にしない** — 補助表示の取得失敗が
  UI のエラーになってはいけない
- **クライアント側も「無ければ何も出さない」に倒す**。プレースホルダーやエラー表示を出すと、
  API キー運用のユーザーに一生消えない警告を見せることになる
- **検証項目に必ず入れる**: `ANTHROPIC_API_KEY` を立てた env で起動し、
  **`available:false` になってバーが出ない**こと (500 やエラー表示にならないこと)

## 3. 実ペイロードは型定義より「広い」 — 型にある鍵だけを読む

- **機構**: `sdk.d.ts` に載っている鍵は**実際に返ってくる鍵の部分集合**でしかない。
  usage の `rate_limits` には型定義に無いコードネーム鍵が多数混ざっていた (2026-08-30 実測:
  `tangelo` / `nimbus_quill` / `iguana_necktie` / `omelette_promotional` / `cinder_cove` /
  `amber_ladder` / `juniper_tide` / `seven_day_cowork` …)。ほぼ null だが値が入るものもある
- **打ち手**: **`sdk.d.ts` に宣言のある鍵だけを読み、残りは無視する**。
  「面白そうな鍵が来ているから使う」は、次のリリースで消える鍵に依存することを意味する。
  読んだ鍵は**自前の型へ写して**外へ出す (SDK の型をそのまま UI まで運ばない)
- **[[pj-agent-status-detect]] の「マッピングを書く前に実ペイロードで真理値表を作る」の裏返し**:
  あちらは「型/ドキュメントより実物が正」、こちらは「実物の方が広いので**型が正**」。
  違いは**契約の有無** — hook のペイロードは観測して合わせるしかないが、SDK の型定義は
  作者が意図的に絞った契約なので、そこから外れた鍵は契約外
- **null は 2 段階ある**: 枠そのものが null (`seven_day_opus: null`) と、
  枠はあるが値が null (`{ utilization: 0, resets_at: null }`)。**実測で `model_scoped[]` の
  `resets_at` が null になった** (枠が未アクティブのとき)。両方 null 安全に扱う

## 4. env は必ず `terminalEnv()` を渡す

`options.env` を指定するとサブプロセスの環境は**マージではなく完全置換**になる (SDK 仕様)。
`agentSession.ts` と同じく `childEnv.ts` の `terminalEnv()` のフルセットを渡し、deck の起動元
シェル由来の汚染 (`NODE_ENV=production` 等) を持ち込まない。詳細は [[pj-child-env]]。

## 5. 実資格情報が要る機能は、検証を 2 つに割る

- **問題**: [[pj-isolated-verify]] の隔離ホーム (`USERPROFILE` 差し替え) では
  `~/.claude/.credentials.json` が見えないため、**サーバー → SDK の実データ経路は測れない**。
  かといって実ホームでサーバーを起動すると `~/.claude-deck3/` の共有資材に触れる
- **打ち手**: **サーバー層とクライアント層を別々に測る**。
  ①**実データ経路**は、サーバーを起動せずに **`tsx` からモジュールを直接 import して関数を叩く**
  (`node_modules/.bin/tsx.cmd --eval 'import("./server/usage.ts").then(...)'`)。
  実 env・実資格情報で走り、共有資材には触れない。**キャッシュ/single-flight の効きも
  ここで測れる** (2 回目が同一オブジェクトで返るか)
  ②**描画と購読**は隔離環境で、①で実際に返ってきた**ペイロードをそのまま使って**
  `window.fetch` を差し替えて測る (`Page.addScriptToEvaluateOnNewDocument` で注入)。
  ついでに**隔離ホームの素の状態が `available:false` の縮退経路そのもの**になるので、
  正常系と縮退系を 1 つの環境で両方踏める
- **合成ペイロードを自分で書かない** — ①で得た実物を貼る。型定義から想像して書くと、
  §3 の「型より広い」も「2 段階の null」も再現できず、検証が素通りする
