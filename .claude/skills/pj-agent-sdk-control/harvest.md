# Harvest Log — pj-agent-sdk-control

## 001: control request を「常駐 1 本 + 縮退 + 型どおりの読み出し」で使う

- date: 2026-08-30
- context: ターミナルタイルのヘッダーに Claude のプラン使用量 (5 時間枠 / 週枠 / モデル別枠) を
  出す機能を実装した。deck には既に hook 経由のエージェント状態検知 ([[pj-agent-status-detect]])
  があるが、使用量は「エージェントが今何をしているか」ではなくアカウント側のデータで、hook では
  取れない。調べると Agent SDK の `Query` に
  `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` があり、`agentSession.ts` が
  `supportedCommands()` / `supportedModels()` を入力前に投げているのと同じ control request 経路で
  引けることが分かった。実際に叩いてみて、型定義とドキュメントからは分からない事実が 3 つ出た:
  (1) プロンプトを 1 通も送らずに呼べる (トークン消費なし) が、CLI 起動のため初回 14.2 秒・
  2 回目以降 2.8 / 1.9 秒 (2) 実ペイロードに `sdk.d.ts` に無いコードネーム鍵が 10 個以上混ざる
  (3) `model_scoped[].resets_at` のように「枠はあるが値が null」の 2 段階 null がある。
  さらに実装後の UI 検証で、タイル分割のたびに余分な fetch が飛ぶ (共有ポーリングの参照カウントが
  ポータル差し替えで往復する) ことを実測して直した — この客側の知見は [[pj-client-ui-state]] §15 へ。
- change: 新規スキルとして起こした。Why = control request は hook と向きも前提も違う別経路で、
  「生きている Query が 1 つ要る」という制約が寿命設計をすべて決める。初回 14 秒という実測が
  「常駐 1 本 + TTL + single-flight」を強制し、EXPERIMENTAL という API 名が「1 ファイルに閉じて
  失敗を機能なしへ畳む」を強制する。How = §1 Query の寿命、§2 3 種の失敗を `available:false` へ
  縮退 (200 で返し 500 にしない)、§3 型にある鍵だけ読む、§4 env は `terminalEnv()`、
  §5 実資格情報が要る機能はサーバー層 (tsx 直叩き) とクライアント層 (実ペイロードを注入した
  隔離環境) に検証を割る。
  **代替案「既存の [[pj-agent-status-detect]] を拡張する」は退けた** — あちらの description は
  hook / SubagentStart / hook-settings.json をトリガー語にしており、control request を混ぜると
  トリガー精度が落ちる。加えて両者は判断が逆向きで (hook = 実ペイロードが正、SDK = 型が正)、
  1 枚に同居させると読み手が規則を取り違える。
  **代替案「`server/usage.ts` の先頭コメントで足りる」も退けた** — Why はそこに書いてあるが、
  次に control request を使う別機能を書くときにそのファイルへは辿り着けない。
  **代替案「毎回 query を spawn して使い捨てる」は実装段階で退けた** — 常駐メモリはゼロになるが
  毎回 14 秒かかり、更新間隔を 5 分まで延ばす必要が出て表示の意味が薄れる (ユーザー確認済み)。
- supersedes: —
- result: `server/usage.ts` として実装し、実資格情報で `subscription_type: "max"` /
  5 時間枠 3% / 週枠 5% / `model_scoped: [{ displayName: "Fable", utilization: 0,
  resetsAt: null }]` を取得。2 回目は同一オブジェクトが 0ms で返り TTL キャッシュも確認。
  隔離ホーム (資格情報なし) では `available:false` で 200 が返り、UI にバーが出ないことを実測。
  クライアント側は実ペイロードを注入して描画と共有ポーリングを検証し、タイル 3 枚・バー 3 個で
  fetch 1 回に収まった。
