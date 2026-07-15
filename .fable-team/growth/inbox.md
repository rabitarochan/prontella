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
