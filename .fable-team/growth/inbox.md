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

- [x] 2026-07-14 | task: git-branch-tree | Rework | builder が「初期値空 = 全フォルダ閉じ」と自己申告したが、実装は `collapsed` Set + `isOpen = !collapsed.has()` で論理が反転しており、実際は全部開いていた。typecheck は通るため型検査では捕まらず、挙動検証で初めて発覚
- [x] 2026-07-14 | task: git-branch-tree | Friction | claude-deck 自身を開発対象にすると、ユーザー稼働中のインスタンスと dev サーバのポート (8110/3711) が衝突し、さらに新クライアントが稼働中 PTY セッションに再接続してブラウザタブがフリーズして検証できなかった
- [x] 2026-07-14 | task: git-branch-tree | Success | 本体アプリが重くて開けないとき、対象コンポーネントだけを単独マウントする使い捨ての Vite ページ (client/*.html + entry.tsx) を立て、DOM を evaluate_script で直接アサートする検証が速くて確実だった
- [x] 2026-07-20 | task: terminal-clipboard | Surprise | ConPTY は子プロセスの DECSET を選別転送する: ?2004 (bracketed paste) と OSC 52 はホストへ通すが、マウストラッキング (?1002/?1006) は素の probe では飲み込んだ。「エスケープシーケンスは素通し」という前提は Windows では成立しない
- [x] 2026-07-20 | task: terminal-clipboard | Success | 別ポート (3799) にテストサーバーを立て、ページ内から side-WebSocket で PTY 入力を注入 + navigator.clipboard と WebSocket.send をモンキーパッチして観測する方式で、キーボードシミュレーション無しにクリップボード/ペーストの E2E 検証ができた
- [x] 2026-07-20 | task: non-git-dirs | Correction | 「非 git ディレクトリー対応」の初回プランで git repo の下位ディレクトリーを「一貫して非 git 扱い」に倒したが、ユーザーは下位ディレクトリーで作業することがあり Git 機能有効を要望。ディレクトリースコープの機能設計では root/subdir/none の 3 状態を最初から検討すべき
- [x] 2026-07-20 | task: non-git-dirs | Success | サーバー検証を PORT=3811 + USERPROFILE をスクラッチに差し替えて起動することで、稼働中インスタンス・実設定 (~/.claude-deck3/config.json) と完全隔離した API 検証ができた(config.ts が os.homedir() 起点なため)
- [x] 2026-07-20 | task: non-git-dirs | Friction | USERPROFILE を差し替えると Volta シムの node/npx が不安定になる(LocalAppData を見失う)。pinned node.exe で tsx の CLI (node_modules/tsx/dist/cli.mjs) を直接叩けば回避できる
- [x] 2026-07-20 22:17 | surprise: tsconfig の extends は exclude をマージしない(build 側 tsconfig にも test 除外が必要。builder C 実測)
- [x] 2026-07-20 22:17 | success: 同一ファイルの並列編集は brief で編集領域を明示的に分割すれば worktree 隔離なしで成立(server/git.ts、builder 2 体)
- [x] 2026-07-20 22:41 | success: レビュー指摘の小修正は元 builder へ SendMessage 継続が速い(コールドスタート回避、attempt 2 は約 2 分で完了)
- [x] 2026-07-21 00:57 | success: ハイリスク純関数の brief に「実物を観察してから fixture を作れ」「apply --check まで通せ」を入れたことで builder が実バグを実装中に自力検出した(git-client-parity 2.1)
- [x] 2026-07-21 | task: editor-state-persistence | Rework | 新モジュール(editorState)の brief で既存モジュールから定数 import させたら、後続タスクで逆方向 import が必要になり循環解消の手戻り。共有定数は依存の最下流(新モジュール側)に最初から置かせるべき
- [x] 2026-07-21 | task: editor-state-persistence | Rework | localStorage sanitize にサイズ上限を入れたら reviewer が「書き込み側が無制限」の非対称を検出(未保存編集の無警告消失窓)。読み捨てる上限には書き込み側の対称ガード+ユーザー通知をセットで設計する
- [x] 2026-07-21 | task: editor-state-persistence | Success | Monaco は隠し textarea が aria-hidden で CDP の実キー入力がブロックされる。React Fiber から editor インスタンスを取得し executeEdits() を呼べば onChange→dirty→debounce の実経路ごと検証できる(verifier 実証)
- [x] 2026-07-21 | task: editor-state-persistence | Surprise | 選択中 worktree は 4 秒ポーリングがファイルハンドルを掴むためか Windows では git worktree remove が 500 で失敗する(force でも)。別 worktree へ切替後は成功。本機能と無関係の既存問題(verifier 発見、未修正)
- [x] 2026-07-21 | mission: git-client-parity | Success | セッション中断で死んだ builder を SendMessage 再開し「まず自分の部分差分を git status/diff で検証→続行」パターンが機能。中断報告は失われてもトランスクリプトと作業ツリーから完全復帰できた
- [x] 2026-07-21 | mission: git-client-parity | Success | フェーズゲート reviewer が並行編集によるハンク誤破棄を実 git で再現して検出(hunkCount のみの楽観ロックの盲点)。不可逆操作の楽観ロックは「数」でなく「対象の同一性」まで検証する — 設計原則として距離できる
- 2026-07-21 | 隔離 USERPROFILE で Volta シムが死ぬ(builder は node.exe 実体 + tsx/dist/cli.mjs 直叩きで回避)— pj-isolated-verify への追記候補 [friction]
- 2026-07-21 | E2E ゲートが実害バグを掘り当てた(PromptDialog 連続プロンプトの state 残留 — Promise ベース連続モーダルは request 毎の key 再マウントが安全パターン)。unit green でも UI 状態バグは E2E でしか出ない [success-pattern]
- 2026-07-21 | E2E ゲート通過後に敵対的レビューが実害インジェクションを発見(rename に -f)— 自由入力を git 引数に渡す新規コードは「-- セパレーター」をチェックリスト化する価値あり [failure→pattern]
- 2026-07-21 19:23 | friction | 隔離検証のスクラッチを深いパスに掘ると Windows で git rebase が Filename too long — pj-isolated-verify に「フィクスチャは短パス(例 C:t5)推奨」を追記したい(5.V で実測・切り分け済み)
- 2026-07-21 19:44 | success | 同型 UI を別コンポーネントに実装すると disabled 条件が非対称になりやすい(HistoryTab のコミットメニューが busy を見落とし、GitTab の rebase 項目だけ busy ガード)。新規 UI 配線は既存の対称物の disabled 条件を突き合わせるチェックを — 5.R が指摘
