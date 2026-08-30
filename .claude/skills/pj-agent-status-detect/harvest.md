# Harvest Log — pj-agent-status-detect

## 001: hook のマッピングは実ペイロードの真理値表を作ってから書く

- date: 2026-08-30
- context: 「サブエージェントが実行中なのに取れない。実行中ではなく待ち状態に
  なってしまう」というユーザー報告から、Orca (stablyai/orca) の実装を参考に
  claude-deck3 の hook ベース検知を作り直した。旧実装は hook ペイロードのうち
  `hook_event_name` / `message` / `notification_type` の 3 つしか転送しておらず、
  `tool_name` `tool_input` `agent_id` `background_tasks` を捨てていた。また
  `Stop` を無条件で idle にしていた。
- change: Why = **リードの `Stop` は子の走行中に飛ぶ**(Agent ツールは非同期で、
  子が終わるとリードが新ターンで再起動される)。並列 Explore 2 本の実測で `Stop` が
  3 回飛び、`background_tasks` が空になる最後の 1 回だけが本当の完了だった。
  これが「実行中なのに待ち状態」の直接原因。親子の判別器は **`agent_id` の有無だけ**で、
  `session_id` も `transcript_path` も親子で同一。`SubagentStop` に載る
  `background_tasks` は古く(当人が running のまま)、そこで畳み込むと止めた子が復活する。
  How = §0 の計測手順(使い捨て HTTP 受信サーバー + `claude -p` で真理値表を作り、
  表にある分岐だけ実装する)を先頭に置き、§1-4 に判別器・完了ゲート・畳み込み規律を、
  §6 に「hook を受けたセッションは hook が権威」を書いた。
  **代替案「hooks と TUI ヒューリスティックを同じ状態機械へ対等に流す」(旧設計) は退けた** —
  `PROMPT_RE` (`❯ 1.`) がエージェントの出力本文に当たって実行中を waiting に落とし、
  スピナー 3 秒タイムアウトが長時間ツールと子を idle に落とすため、hook が正しくても
  ヒューリスティックが上書きしてしまう。
  **Orca の「`background_tasks` の非エージェント走行分も完了ゲートに入れる」も退けた** —
  `run_in_background` の dev サーバーは終わらないのが正常で、恒久 busy になる。
  `type: 'subagent'` のみをゲートに使い、他は表示フラグにとどめる。
- supersedes: —
- result: 純関数の状態機械 (`server/claudeHookState.ts`) と実測シーケンスを写した
  単体テスト 26 件。隔離サーバー + 実 `claude` の E2E で「親の `Stop` 後も子が終わるまで
  busy 維持」を実測。UI は実記録ペイロード 21 件の再生で DOM がサーバー API と全ステップ
  一致することを確認。敵対的入力(XSS・巨大本文・不正 JSON・50 子)も通過。

## 002: hook 設定は `--settings` に据え置く(Orca の settings.json 方式を退けた)

- date: 2026-08-30
- context: 001 で転送を `type: "http"` の HTTP hook に移行した直後、ユーザーから
  「Orca と同様に user の settings.json に含めるのはどうか」と問われた。Orca は
  `~/.claude/settings.json` に管理エントリーをマージするので、手打ちの `claude` や
  `claude -c` でも検知が効く(claude-deck3 の `--settings` 方式では効かない)。
- change: Why = Orca が settings.json に置けるのは、**フックがスクリプトで自己ゲートできる**
  から(`ORCA_PANE_KEY` が空なら即 exit)。HTTP hook に条件分岐は書けないので、
  Orca 方式を丸ごと踏襲すると**マシン上のすべての claude が、何もしない場合でも
  1 イベントあたりプロセス起動を払う**。実測(高負荷時): HTTP 24ms に対し
  bash+curl 610ms、自己ゲートで即 exit しても 295ms、PowerShell ラッパー 1249ms。
  `PreToolUse`/`PostToolUse` はサブエージェント内のツールでも発火するため本数ぶん積み上がる。
  併せて「deck 停止中の騒がしさ」も測り、**可視エラーは `SessionEnd` の 1 行だけ**で
  他イベントの失敗は無音だと分かった(= settings.json + HTTP hook という Orca に無い
  組み合わせも技術的には成立する)。
  How = ユーザーの判断で `--settings` 据え置き。SKILL.md §5 には HTTP hook の契約と
  コスト実測表を残し、`~/.claude/settings.json` は**読むだけ**(`allowedHttpHookUrls` /
  `allowedEnvVars` による無効化を起動時に警告)という線を明記した。
  **退けた案 (a) settings.json + 自己ゲートするコマンドフック(Orca 完全踏襲)** —
  今回 HTTP hook 化で消したプロセス起動コストを全 claude セッションに戻すことになる。
  **退けた案 (b) settings.json + HTTP hook** — 速度は保てるが、ユーザー所有ファイルの
  書き換え(マージ/除去/排他)が要り、deck 外の claude のペイロードも 127.0.0.1 の
  deck ポートへ飛ぶ。ユーザーが「実ファイル未変更・後始末不要・漏れゼロ」を選んだ。
- supersedes: —(001 の転送方式そのものは据え置き。置き場所だけを決めた)
- result: コード変更なし。制約として「デッキの `✦ Claude 起動` 以外で立てた claude
  (手打ち・`claude -c`・TUI 内での再起動) には hooks が付かず、サブエージェント表示が
  出ない」が残ることをユーザーに明示して合意した。
