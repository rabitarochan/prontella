# デバッガー (DAP) MVP — Node/TS 先行 (vscode-js-debug)

> 作成日 2026-09-29。**実装済み** (`server/debug/*`, `client/src/debug/*`, `client/src/components/DebugTab.tsx`)。
> 測定値と実装中に変わった前提は `scripts/dap-spike/RESULTS.md` が正。ここは設計の決定と構造の記録。

## 決定事項 (ユーザー確認済み)

| 項目 | 決定 |
|---|---|
| 対象 | Node/TS (vscode-js-debug、MIT、TCP) と C# (netcoredbg、MIT、stdio)。アダプター id で表を引く (`server/debug/registry.ts` の `ADAPTERS`)、WS の `adapter=` で選ぶ。vsdbg はライセンス上不可 |
| 入手 | 自動ダウンロード: GitHub release → `~/.prontella/tools/<js-debug|netcoredbg>/<ver>/` (bsdtar で tar.gz / zip を展開)。解決順 = config.json の明示 (`debug.node.dapDebugServer` / `debug.csharp.netcoredbg`) > tools > VS Code 拡張 (node) / PATH (csharp) > ダウンロード |
| 起動設定 | `.vscode/launch.json` 互換 (JSONC、`type` ∈ {node, pwa-node, coreclr}、launch/attach、`${workspaceFolder}`/`${file}` のみ置換)。無ければ内蔵既定「アクティブファイルを実行」: `.js` は node、`.ts` は root の tsx、`.cs` は最寄り `.csproj` のビルド済み `bin/Debug/<tfm>/<proj>.dll` |
| C# の env | netcoredbg は PATH の `dotnet` が要る (DOTNET_ROOT だけでは不可)。LSP と同じ `lsp.csharp.dotnetRoot` を `launchEnv()` で PATH に重ねる |
| MVP 範囲 | 行 BP (ガター) / 開始・一時停止・続行・ステップ 3 種・停止 / 現在行 / コールスタック / 変数 (遅延展開) / デバッグコンソール (output + REPL)。stdio は `internalConsole` (launch.json の `console` は上書き) |
| 後回し | 条件付き BP / ウォッチ / ホバー評価 / integratedTerminal (`runInTerminal` → PTY。`PtyManager.create` に env 拡張が要る、RESULTS.md D9) / C# の attach と `dotnet build` の自動実行 |

## 構造

```
DebugTab.tsx ── useDebugStore (client/src/debug/store.ts: 状態・ハンドシェイク・イベント reducer)
     │             └ DebugRun (client/src/debug/session.ts: 1 実行 = 1 WS、再接続しない)
     │  decorations.ts / glyphs.ts: Monaco モデルに BP グリフと現在行を張る (React に載せない)
     ▼  /ws/debug?root=  素の DAP + `sessionId`、合成イベント prontella/status・prontella/session
server/debug/session.ts   接続の集合 (root + startDebugging ごとに 1 本)、launch 引数の注入、パス書き換え、逆要求、後始末
server/debug/host.ts      dapDebugServer.js を spawn (TCP、port 0)、接続ごとに Content-Length フレーミング (server/lsp/framing.ts)
server/debug/registry.ts  config 検証・解決順・自動ダウンロード (single-flight、完成形は rename でだけ現れる)
server/debug/launchConfig.ts  JSONC 解釈・検証・変数置換・内蔵既定 (純関数)
```

## 設計の要点

- **クライアントは launch/attach の本体を送らない**: root は `{name}` か `{file}`、子は空。本体はサーバーが launch.json から組む /
  `startDebugging` の configuration を注入する → ブラウザー由来の絶対パス・任意コマンドがアダプターに届かない
- **パス**: アダプター→クライアントは `source.path` を root 相対に (root 外は path を消す)、クライアント→アダプターは
  `setBreakpoints.source.path` と `{file}` だけ `safeResolve` で絶対化
- **ハンドシェイクは VS Code と同じ順序**: initialize → launch (応答は待たない) → `initialized` → setBreakpoints → configurationDone →
  launch 応答。netcoredbg は configurationDone を先に受けると launch に応答しない (js-debug はどちらでも通る)
- **多重化**: vscode-js-debug は root 接続をランチャーにし、実ターゲットは `startDebugging` 逆要求 → 別 TCP 接続で動く。
  停止・出力は子に来る。クライアントは `prontella/session` を受けたら子でも同じハンドシェイクを回す。netcoredbg は接続 1 本
- **後始末**: WS が閉じたら root に `disconnect{terminateDebuggee}` を送り、応答は待たず 1 s で adapter を kill。
  アダプターは 1 実行が終わっても自分では終わらないので、クライアントが root の `terminated` で接続を閉じる
- **BP の検証状態**: setBreakpoints 応答の要求順で対応付け (id は重複する)、`breakpoint` changed は id で引く。実行していないときは塗る

## 検証

- 単体: `server/debug/*.test.ts` (JSONC・解決順・ダウンロードの原子性・セッションの書き換え/逆要求/後始末)、
  `client/src/debug/*.test.ts` (reducer・BP 永続化・装飾)
- 隔離 E2E (2026-09-29): 隔離 home + port 4711 で `/ws/debug` を Node の ws から直叩き (31 項目) + headless Chrome の CDP で UI
  (ガタークリック → 開始 → 停止 → ステップ → 別ファイルのフレームへ着地 → REPL → 続行 → 終了 → 再開始、リロード後の BP 復元)。
  自動ダウンロードは隔離 home の `~/.prontella/tools/` に落ち、実 home は無傷
