# Growth signal inbox

> **Append one line the moment you notice something. Don't analyze — just capture. (Analysis comes later — /fable-team:grow does it.)**
>
> Format: `- [ ] date | mission | type | what happened (one line)`
>
> Types:
> - **Correction** — feedback or a correction from the user (highest-priority signal; even a single one is a candidate for distillation)
> - **Rework** — something had to be redone (include the cause)
> - **Failure** — an escalation occurred (e.g., builder failed twice)
> - **Surprise** — an assumption was wrong, or reality differed from expectations
> - **Friction** — repeating the same setup every time, information hard to find, heavyweight procedures
> - **Success** — a pattern that worked well (worth reproducing)
>
> When processed, mark it `[x]` and leave an entry in `changelog.md` (**Discarding is a valid outcome.**).

## Signals

- [ ] 2026-07-14 | task: git-branch-tree | Rework | builder が「初期値空 = 全フォルダ閉じ」と自己申告したが、実装は `collapsed` Set + `isOpen = !collapsed.has()` で論理が反転しており、実際は全部開いていた。typecheck は通るため型検査では捕まらず、挙動検証で初めて発覚
- [ ] 2026-07-14 | task: git-branch-tree | Friction | claude-deck 自身を開発対象にすると、ユーザー稼働中のインスタンスと dev サーバのポート (8110/3711) が衝突し、さらに新クライアントが稼働中 PTY セッションに再接続してブラウザタブがフリーズして検証できなかった
- [ ] 2026-07-14 | task: git-branch-tree | Success | 本体アプリが重くて開けないとき、対象コンポーネントだけを単独マウントする使い捨ての Vite ページ (client/*.html + entry.tsx) を立て、DOM を evaluate_script で直接アサートする検証が速くて確実だった
- [ ] 2026-07-20 | task: terminal-clipboard | Surprise | ConPTY は子プロセスの DECSET を選別転送する: ?2004 (bracketed paste) と OSC 52 はホストへ通すが、マウストラッキング (?1002/?1006) は素の probe では飲み込んだ。「エスケープシーケンスは素通し」という前提は Windows では成立しない
- [ ] 2026-07-20 | task: terminal-clipboard | Success | 別ポート (3799) にテストサーバーを立て、ページ内から side-WebSocket で PTY 入力を注入 + navigator.clipboard と WebSocket.send をモンキーパッチして観測する方式で、キーボードシミュレーション無しにクリップボード/ペーストの E2E 検証ができた
- [ ] 2026-07-20 | task: non-git-dirs | Correction | 「非 git ディレクトリー対応」の初回プランで git repo の下位ディレクトリーを「一貫して非 git 扱い」に倒したが、ユーザーは下位ディレクトリーで作業することがあり Git 機能有効を要望。ディレクトリースコープの機能設計では root/subdir/none の 3 状態を最初から検討すべき
- [ ] 2026-07-20 | task: non-git-dirs | Success | サーバー検証を PORT=3811 + USERPROFILE をスクラッチに差し替えて起動することで、稼働中インスタンス・実設定 (~/.claude-deck3/config.json) と完全隔離した API 検証ができた(config.ts が os.homedir() 起点なため)
- [ ] 2026-07-20 | task: non-git-dirs | Friction | USERPROFILE を差し替えると Volta シムの node/npx が不安定になる(LocalAppData を見失う)。pinned node.exe で tsx の CLI (node_modules/tsx/dist/cli.mjs) を直接叩けば回避できる
- 2026-07-20 22:17 | surprise: tsconfig の extends は exclude をマージしない(build 側 tsconfig にも test 除外が必要。builder C 実測)
- 2026-07-20 22:17 | success: 同一ファイルの並列編集は brief で編集領域を明示的に分割すれば worktree 隔離なしで成立(server/git.ts、builder 2 体)
- 2026-07-20 22:41 | success: レビュー指摘の小修正は元 builder へ SendMessage 継続が速い(コールドスタート回避、attempt 2 は約 2 分で完了)
