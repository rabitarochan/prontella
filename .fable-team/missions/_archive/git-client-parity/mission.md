# Mission: git-client-parity

- slug: `git-client-parity`
- Start date: 2026-07-20
- Status: completed(2026-07-23。DoD 全 8 項目 ✅ + 任意項目の 6.5 blame も完了)
- Conductor: fable
- The user's request (verbatim):
  > Git タブのもつ機能について、Git クライアント (SourceTree, GitKraken など) を全く使わなくても Claude Deck のみで作業が完結できるように、不足している機能を洗い出しして、実装計画を立ててください。

## Goal

Claude Deck の Git タブのみで日常の Git 作業が完結し、外部 Git クライアント(SourceTree /
GitKraken 等)が不要になる。不足機能の洗い出しと実装計画は完了済み(plan.md)。本ミッションは
その計画(Phase 0–6)を実装しきるところまでを含む。

## Definition of Done

- [x] ハンク/行単位のステージ・アンステージ・破棄ができる(CRLF / Shift_JIS 混在でも内容が壊れない)
- [x] マージ/rebase/cherry-pick/revert のコンフリクトを Deck 内で解決し、continue/abort/skip できる
- [x] --no-ff マージ(UI 既定)・複数行 Conventional Commit(body 入力と履歴での表示)・直前コミット取り消し・全変更破棄ができる
- [x] リモートブランチのチェックアウト/削除、branch rename、force-with-lease push、pull --rebase、remote 管理(add/remove/set-url)ができる
- [x] 任意コミットへの reset(soft/mixed/hard)、cherry-pick、revert、通常 rebase ができる
- [x] タグ管理(作成/削除/push)、stash 差分閲覧、ファイル履歴、履歴検索ができる
- [x] 破壊的操作はすべて統一 ConfirmDialog(danger)経由で、キャンセルすると無変更
- [x] 各フェーズが verifier の実操作検証と reviewer のレビューゲートを通過している

## Verification harness (this project's feedback loop)

| Check | Command | Approx. duration |
|---|---|---|
| Tests (full) | `npm run test`(vitest。Phase 0.4 で導入 — 導入後にこの行を確定させる) | 数秒(見込み) |
| Tests (partial) | `npx vitest run <file>`(導入後) | 数秒(見込み) |
| Lint / type check | `npm run typecheck`(client/src と server/ の tsc --noEmit 並列。lint は無し) | 3–5 秒 |
| Launch & smoke check | `npm run dev` → server :3711 + client :8110(HMR あり)。http://localhost:8110 で実操作 | 起動 5–8 秒 |

## Constraints

- 新規 API は既存 3 層パターンを踏襲: server/git.ts(runGit / runGitInput)→ server/index.ts(asyncHandler、{error} JSON)→ client/src/api.ts
- gitMode(root/subdir/none)対応: 操作系 endpoint は必ず bodyDir()/requireKnownDir() で git root に正規化。path は root 相対 forward-slash
- 型共有機構が無いため、client/src/types.ts と server 側の型は**同一タスク内で手動同期**
- UI 表記は日本語。ユーザーの運用: マージは --no-ff 既定、コミットは Conventional Commits(body あり)
- force push は常に --force-with-lease(bare --force 禁止)。破壊的操作は ConfirmDialog(danger)必須
- 競合ファイルの読み書きは encoding 対応の files.ts 経路を使う(index.ts diff-pair の utf8 直読み経路に載せない)
- git 2.23+ 前提(switch/restore)。認証は資格情報ヘルパー前提(GIT_TERMINAL_PROMPT=0 維持)

## Out of scope

- 対話的 rebase(squash/fixup/並べ替え)、reflog 閲覧・復元、bisect、format-patch/am — P2、別ミッション候補
- submodule / GPG・SSH コミット署名 / Git LFS / クレデンシャル入力 UI — ユーザー承認済みの除外(必要になったらターミナルタブで代替)
