---
name: pj-agent-status-detect
description: >
  prontella で Claude Code の hook からエージェントの実行状態・実行中ツール・
  サブエージェントを検知する実装に触れるときの定石。親子の判別器、完了ゲート
  (リードの Stop で終わりにしない)、HTTP hook の契約、TUI ヒューリスティックとの
  優先順位、そして**マッピングを書く前に実ペイロードで真理値表を作る**手順。
  hooks / ステータス検知 / サブエージェント表示 / agent_id / background_tasks /
  SubagentStart / SubagentStop / hook-settings.json に触る実装・調査タスクを
  委任するとき、brief の References にこのファイルのパスを入れる。
---

# pj-agent-status-detect — hook によるエージェント状態検知(prontella)

## 収録基準

**実ペイロードを採って初めて分かった型**だけを載せる。Claude Code のドキュメントや
他実装(Orca 等)の記述から読める内容は書かない — それらは当てにならないことが
この領域の主題だから。1 項目は「症状 → 機構 → 打ち手」で短く。

**扱うのは hook (Claude → deck のプッシュ) だけ。** deck 側から Agent SDK の `Query` を
引く経路 (コマンド/モデル一覧・使用量などの control request) は前提も規律も逆向きなので
[[pj-agent-sdk-control]] を見ること(あちらは「実物より型が正」— 契約の有無が違う)。

## 0. マッピングを書く前に実ペイロードを採る

**この手順を飛ばして書いた状態マッピングは必ず外す。** 他実装の記述も、前回の自分の
記録も、Claude Code のバージョンが変われば嘘になる。

1. 全イベントを `type: "http"` で登録した使い捨て設定 JSON と、受けた本文とヘッダーを
   1 行 1 JSON で追記するだけの受信サーバー(素の `node:http`)を用意する
2. `claude -p --settings <file>` でシナリオを走らせる。**対話 TUI を駆動しなくてよい**
3. 「イベント × (`agent_id` の有無 / 主要フィールド)」の真理値表を作る
4. **表にある分岐だけ実装する。** 表に無いイベントは「状態を保つ/精緻化する」向きに
   しかマッピングしない(発火しなくても届いても実行中を誤って解除しない形にする)

`claude -p` で採れるシナリオ: 単純なツール 1 回 / Task 並列 n 本 / 親の応答終了と
子の走行の重なり / `SessionEnd`。
**採れないもの**: `SessionStart`(print モードでは出ない)、`PermissionRequest`、
`Notification`、`PostCompact`、`StopFailure`、`TeammateIdle` — いずれも対話ダイアログが要る。

## 1. 親子の判別器は `agent_id` の有無だけ

`session_id` も `transcript_path` も**親子で同一**。`prompt_id` はリードのターンごとに
変わるので、これも判別には使えない。子(サブエージェント)由来のイベントにのみ
`agent_id` と `agent_type` が入る。

決定則: **子のイベントでリードのターン状態とツールカードを書き換えない**。roster
(子の台帳)と子の activity だけを更新する。例外は waiting 誘発イベント
(`PermissionRequest` 等)— 人の対応が要るのでペイン全体を waiting にする。

## 2. リードの `Stop` は「終わった」ではない

Agent ツールは**非同期**で、子が終わるとリードが新しいターンで再起動される
(新しい `prompt_id` の `UserPromptSubmit`)。並列 2 本の実測:

```
 9 PreToolUse   agent=ab… Read      ← 子が作業中
10 PreToolUse   agent=af… Glob      ← 子が作業中
11 Stop         agent=-  background_tasks=[af…running, ab…running]   ← リードのターン終了
…
19 Stop         agent=-  background_tasks=[]                          ← ここで初めて完了
```

**`Stop → idle` の無条件マッピングが「実行中なのに待ち状態になる」の直接原因。**
決定則: `Stop` で lead を idle にしつつ、走行中の子が残るなら**外向きステータスは busy を維持**する。
外向きの導出順は `waiting`(人の対応待ち)> 走行中の子あり > lead working > lead idle。

## 3. `background_tasks` の畳み込みは `agent_id` の無い `Stop` 限定

`SubagentStop` にも同じ配列が載るが**古い** — たった今止めた当人が `running` のまま
載っている。そこで畳み込むと、止めた子が復活して busy が固着する。

- 配列が**無い**版では roster をそのまま保つ(畳み込まない)
- **空配列だけが「全滅の証拠」**。載っていない `subagent` 行は終了済みとして消してよいので、
  `SubagentStop` を取りこぼしても回収できる
- 要素の `id` は `SubagentStart` の `agent_id` と一致する(照合可能)

## 4. 完了ゲートに入れてよいのは `type: 'subagent'` だけ

- `teammate` は**恒久的に running を報告しうる**
- 非エージェントのバックグラウンドタスク(`run_in_background` の dev サーバー等)は
  **終わらないのが正常**

どちらもゲートに入れると永久 busy になる。表示用のフラグにとどめる。
(Orca はゲートに入れているが、この 2 つの固着を踏む設計になっている。)

## 5. HTTP hook の契約

```jsonc
{ "type": "http", "url": "http://127.0.0.1:<port>/api/agent-events", "timeout": 3,
  "headers": { "X-Deck-Term": "${PRONTELLA_TERM}" },
  "allowedEnvVars": ["PRONTELLA_TERM"] }
```

- **env 補間には `allowedEnvVars` への明示列挙が必要**(未列挙の `$VAR` は空文字に潰れる)。
  `${VAR}` `$VAR` どちらの書式も通る
- **この env 名は「両端」で持つ契約**: 注入側(`server/pty.ts` が PTY に載せる env)と
  参照側(`server/hooks.ts` が書く header と `allowedEnvVars`)が同じ名前を指している。
  **片方だけ変えると hook は空文字のヘッダーを送り、受け側は「未知の term」として黙って捨て、
  TUI ヒューリスティックへ静かに退行する** — 型検査もテストも green のまま、画面のステータス
  だけが鈍るので気づけない(2026-09-01 の `CLAUDE_DECK_TERM` → `PRONTELLA_TERM` 改名で
  踏みかけた)。名前を変えるときは両ファイルを同一の変更として扱い、**実測で確かめる**:
  PTY 側は `$env:<VAR>` をファイルへ書き出させ、hook 側は `X-Deck-Term` 付きの POST を
  投げてステータスが遷移することを見る
- **受け側は必ず 200 + JSON を返す。** 未知の term も本文破損(不正 JSON・サイズ超過)も 200。
  deck 都合で hook を失敗させない。**パス限定の express エラーハンドラー**で担保する
  (共通ハンドラーに流すと 500 が返る)
- 失敗時に**ユーザーの画面へ出るのは `SessionEnd` だけ**。他イベントの失敗は無音
- コスト実測(高負荷時の値。比率を見る): HTTP 24ms / bash+curl 610ms /
  自己ゲートで即 exit しても 295ms / PowerShell ラッパー 1249ms。
  **`PreToolUse`/`PostToolUse` はサブエージェント内のツールでも発火する**ので、
  プロセス起動型のフックはツール本数ぶん積み上がる
- ユーザーの `~/.claude/settings.json` の `allowedHttpHookUrls` / `allowedEnvVars` は
  設定ソース横断で**交差**して効く → deck の hook が丸ごと無効化されうる。起動時に読んで警告する
  (書き込みはしない。`--settings` 方式を選んだ経緯は harvest.md 002)

## 6. hook を受けたセッションは hook が権威

TUI ヒューリスティックと「同じ状態機械に流す」設計は破綻する:

- `PROMPT_RE`(`❯ 1.` 等)は**エージェントの出力本文にも当たり**、実行中を waiting に落とす
- スピナー 3 秒タイムアウトは、長時間ツールやバックグラウンドの子を idle に落とす

決定則: hook を 1 度でも受けたセッションでは、ヒューリスティックからステータス決定を降ろす。
**残すのは shell 復帰検知だけ**(claude がクラッシュして `SessionEnd` を出せない場合の回収)で、
これは **busy 中でも見る**。塞ぐと stale ガードの猶予ぶん busy に居座る。
代わりに長い stale ガード(hook も PTY 出力も途絶えて 10 分)を置く。

**`/api/agent-events` は無認証**なので、`hook_event_name` を持たない本文でセッションを
「hook 権威」に切り替えてはいけない — ゴミを 1 発投げるだけでそのターミナルの検知を殺せる。
入力の上限・制御バイト処理は [[pj-untrusted-input]] に従う。

## 7. 状態は副作用のない純関数に切り出す

roster と完了ゲートは分岐が多く、`PtyManager` に直書きすると単体テストできない。
**実測シーケンスをそのままフィクスチャにして**、「リード Stop + 走行中の子あり → busy 維持」と
「同 + 子ゼロ → idle」の**両分岐**を固定する。

## 8. activity の変化はステータス据え置きでも配信が要る

ツール名やサブエージェント一覧は、ステータスが busy のまま動く。`setStatus` の
「同じなら早期 return」に巻き込まれるので**別経路で配信**する。1 ツールにつき Pre/Post の
2 発 × 子の本数まで増えるので、短い窓(実装は 250ms)で合体させる。

クライアント側の鮮度(ポーリングとプッシュの被せ方)は [[pj-client-ui-state]] §13。

## 検証

隔離手順は [[pj-isolated-verify]]。この領域で特に効くのは:

- 共有資材(`~/.prontella`)の生成は `HOME` を差し替えた別プロセスに追い出し、
  実資材の diff で無傷を証明する
- UI の検証は**実記録ペイロードの再生**で行う(実エージェントの再実行より速く決定的)
- サーバーの API と DOM を**同一スクリプトで同時に測る**。片方だけ見ると、どちらの層の
  遅れなのか区別できない
