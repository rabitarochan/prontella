# scripts/bench — ターミナルパネル計測ハーネス

prontella のターミナルパネル (PTY + xterm.js + `/ws/term`) の高速化を、隔離環境で
再現可能に計測するためのハーネス。実 `~/.prontella` / 実インスタンス (server 3711 /
vite 8110) には一切触れない。

## 前提

- `npm run build` 済みであること (`client/dist` が `client/src` より新しいことを起動時に
  チェックする。古ければ警告して終了する。`--force` で無視して続行できる)。
- Windows / Chrome (`%ProgramFiles%\Google\Chrome\Application\chrome.exe` 等から自動検出。
  見つからなければ `--chrome <path>` で明示する)。
- Node 組込み API のみで動く (追加依存なし)。`fetch` / `WebSocket` はグローバルを使う。

## 使い方

```
node scripts/bench/term-bench.mjs --label before --sessions 6 --seconds 20 --hz 10 --lines 20
node scripts/bench/term-bench.mjs --label after  --sessions 6 --seconds 20 --hz 10 --lines 20
node scripts/bench/compare.mjs results/before.json results/after.json
```

### CLI オプション (term-bench.mjs)

| オプション | 既定 | 説明 |
| --- | --- | --- |
| `--label <name>` | (必須) | 結果ファイル名 (`results/<label>.json`)。英数字/-/_のみ |
| `--sessions <n>` | 6 | 作る PTY セッション数 (= 1 worktree のタブ数) |
| `--seconds <n>` | 20 | M2 (steady) の負荷生成時間 |
| `--hz <n>` | 10 | load.ps1 の再描画レート |
| `--lines <n>` | 20 | load.ps1 の再描画ブロック行数 |
| `--port <n>` | 4751 | 隔離サーバーのポート (実インスタンスの 3711/8110 とは別) |
| `--cdp <n>` | 9733 | Chrome の `--remote-debugging-port` |
| `--chrome <path>` | 自動検出 | chrome.exe を明示指定 |
| `--keep` | off | 終了時に隔離環境 (`vt/bench-<label>-<pid>/`) と Chrome を残す (デバッグ用) |
| `--force` | off | ビルド鮮度チェックを無視して続行 |

## 何をしているか (手順)

1. `vt/bench-<label>-<pid>/home` を隔離 `USERPROFILE`/`HOME` として、`vt/bench-<label>-<pid>/repo1`
   に git 初期化した空リポジトリー (1 コミット) を作る。
2. `node_modules/tsx/dist/cli.mjs server/index.ts` を `process.execPath` (Volta シムでは
   なく実体 node.exe) で、隔離 env + 隔離ポートで起動する。
3. `POST /api/repos` で repo1 を登録し、`POST /api/terminals` で `--sessions` 本の PTY
   セッションを **API 経由で** 作る (`run` は渡さない — Claude は絶対に起動しない)。
4. 隔離プロファイルで Chrome を起動し、CDP 直叩きで 2 ページを開く:
   - **ページ A (worktree)**: `localStorage['prontella.selected']` を repo1 に向けて
     worktree ページを開く。タイルの `adoptSessions` が既存の PTY セッションを
     全てタブとして拾う (可視 1 枚 + 非表示 N-1 枚)。
   - **ページ B (monitor, 別ウィンドウ)**: `sessionStorage['prontella.monitorActive']='1'`
     でターミナルモニターを開く (全セッションが同じグループのタブとして並ぶ)。
   - 両ページに `window.WebSocket` のラッパーと `PerformanceObserver({type:'longtask'})`
     を `Page.addScriptToEvaluateOnNewDocument` で仕込む (`lib/inject.mjs`)。
     `window.__benchSnapshot()` で `/ws/term` 等 pathname ごとの送受信フレーム数・
     バイト数・longtask 累計を JSON で取れる。
5. 4 フェーズを計測する (実行順は M2 → M1 → M3 → M4。M1 は M2 の負荷で各セッションの
   スクロールバックが埋まった後に測らないと snapshot の再生コストが出ないため):
   - **M1 attach**: ページ B を `Page.reload` → 全 term ソケットが `snapshot` を受信する
     までの ms、snapshot 合計バイト数、reload 〜 +3秒の `Performance.getMetrics` 差分。
   - **M2 steady**: ページ B を `bringToFront` した状態で、検証用の生ソケット
     (`/ws/term?id=`、ブラウザーを介さない) から各セッションへ
     `& '<load.ps1>' -Seconds <s> -Hz <hz> -Lines <lines> -Cols 100\r` を入力する。
     `--seconds` 秒 + 2 秒の間、サーバー PID の CPU 時間差分 (`Get-Process`) / RSS と、
     ページ A・B それぞれの `getMetrics` 差分・longtask・WS 受信バイト数を測る。
   - **M3 resize storm**: ページ A (worktree) のアクティブグループを分割ボタン
     (`.term-group .term-tab-buttons .codicon-split-horizontal` の親 button) で分割し、
     新しくできた `.pane-separator` を 30 ステップ・1.5 秒で 200px ドラッグする。
     ドラッグ側 (page A) が送った `resize` フレーム数、もう一方 (page B) が受信した
     `resize` フレーム数、ドラッグ中のサーバー CPU 差分、page A の longtask を測る。
   - **M4 reconnect**: ページ B の全 `/ws/term` ソケットを `window.__benchCloseSockets`
     で `close()` し、全てが再び `snapshot` を受け取るまでの ms と longtask を測る。
6. `results/<label>.json` に生データを保存し、標準出力に Markdown 表 (15 指標) を出す。
7. 後始末: 検証用ソケット close → サーバー kill (taskkill /T) → ポート解放待ち →
   自分が起動した Chrome だけ kill (spawn した pid で taskkill /T、他エージェントの
   Chrome には触れない) → `vt/bench-<label>-<pid>/` を削除 (`--keep` 時は残す)。
   `finally` で必ず実行する (SIGINT でも同様)。

## 指標の意味

- **attachMs / reconnectMs**: 「N 個の xterm タブを一斉に開いた/繋ぎ直した」ときの
  体感待ち時間に近い。全 term ソケットが `snapshot` を受け取るまでの壁時計時間。
- **snapshotBytes**: reattach 時にサーバーが流す `scrollback` の総バイト数
  (スクロールバック trim・差分送信などの効果がここに出る)。
- **serverCpuSecondsPerWallSecond**: 1.0 = CPU 1 コアを張り付かせている状態。
  複数セッション分の PTY 出力処理・ANSI 走査・broadcast のコストの目安。
- **TaskDuration/ScriptDuration/LayoutDuration/RecalcStyleDuration diff**:
  `Performance.getMetrics` の累積値をフェーズ前後で引き算した増分 (秒)。
  レンダラープロセスの負荷。
- **JSHeapUsedSize diff**: フェーズ中のヒープ増加量 (絶対サイズの差。リークの傾向は
  見えるが、GC タイミング次第でノイズが乗る)。
- **longtaskCount/longtaskMs**: `PerformanceObserver({type:'longtask'})` が拾った
  50ms 超のメインスレッドタスクの件数と合計時間。UI のカクつきに直結する指標。
- **wsBytesReceived / resizeFrames\***: `/ws/term` フレームを type 別に数えたもの
  (`window.WebSocket` のラッパー計測。ブラウザー内の実 WebSocket を素通しで包むので
  再接続・切断イベントも含めて正確)。

## 既知の制約 / 注意点

- **M1 の `Performance.getMetrics` 差分は負値になることがある**(実測: `TaskDuration diff` が
  `-1.961` 秒など)。`Page.reload` はドキュメントを作り直すため、`TaskDuration`/
  `ScriptDuration` 等の累積値がナビゲーションをまたいで正しく引き継がれない (Chrome の
  実装依存)。M1 のこの 2 指標は「前後比較の相対値」としてではなく、**同じ条件で複数回
  実行したときの分布の変化**を見る用途に限定するのが安全。M2/M3 (ナビゲーションを挟まない)
  では観測されていない。
- **`.pane-separator` は FilesTab/GitTab のサイドバー幅調整にも使われており、それらは
  非アクティブでも `display:none` のまま常駐マウントされている**
  (`client/src/components/SplitPanel.tsx` のコメント参照)。M3 で分割直後の
  `document.querySelectorAll('.pane-separator')` の **先頭要素は非表示側を拾うことがある**
  (実測: index 0 が real ターミナル分割線ではなく隠れたサイドバー境界で、ドラッグしても
  `resize` フレームが 0 件のまま気づかず終わるところだった)。このハーネスは
  `.term-body .pane-separator` にスコープして回避している — 同じ手法を他の検証で
  流用するときもスコープを絞ること。
- **M3 の分割対象はページ A (worktree) 側**にした (ページ B のタブを右端ゾーンへ DnD で
  分割する代替案もブリーフで許容されていたが、ネイティブ DnD の合成より分割ボタンの
  trusted click の方が決定的で速い)。ドラッグしたのが A なので、`resizeFramesSentByDriver`
  は A が送った数、`resizeFramesReceivedByOther` は B が受信した数になる (ブリーフの
  「B が送る」想定とは送受が入れ替わっているだけで、測っている経路は同じ)。
- **ページ B (monitor) の可視ターミナルは常に 1 枚**: `--sessions` を増やしても
  同一 worktree のセッションは 1 グループのタブに積まれるため、同時可視枚数を
  増やす検証 (複数ペイン同時表示) は別途 DnD でグループを分割する必要がある
  (Phase 2 の宿題としてブリーフに明記あり。このハーネスは M3 の 1 回の分割のみ行う)。
- **JSHeapUsedSize** はフェーズの前後で GC が挟まるかどうかに左右されるノイズの
  多い指標。単発の実行で結論を出さず、複数回の平均や傾向で見ること。
- **サーバー CPU** は `Get-Process -Id <pid> | .CPU` (累積 CPU 時間、秒) の差分を
  壁時計時間で割ったもの。Windows の `Get-Process` の解像度上、非常に短い区間
  (M3 のドラッグ 1.5 秒など) では丸め誤差が相対的に大きくなる。`--sessions 3 --seconds 8`
  程度のスモーク規模だと `0.000` (=3 桁丸めで検出限界未満) に収まることがある — 実測差分を
  見るには 6 段階比較で使う規模 (`--sessions 6 --seconds 20` 以上を想定) が必要。
- **後始末は `taskkill /PID <server.pid> /T /F` だけに頼らない**: node-pty (ConPTY) が
  生む pwsh.exe シェルは Windows のプロセスツリー上で taskkill の再帰対象から漏れることが
  実測で確認された (サーバーを kill してもシェルだけ生き残り、隔離 home 配下のファイル
  ハンドルを握ったまま `vt/` の削除を失敗させた)。このハーネスはサーバーが応答するうちに
  `POST /api/terminals/:id/kill` で全 PTY セッションを明示 kill してから taskkill する
  (`term-bench.mjs` の `cleanup()` 参照)。同じ構成で別の検証ハーネスを書くときも
  「taskkill /T で子プロセスが本当に全部落ちたか」は当てにしないこと。
- **`--sessions` を増やすと M1/M4 の待ち時間が伸びる**。既定の 45〜60 秒の
  タイムアウトで足りない場合はコード側の `timeoutMs` を調整すること (CLI 化はしていない)。
- スモークテストの結果は `results/smoke.json` に置いてある (Conductor が捨てる想定)。
