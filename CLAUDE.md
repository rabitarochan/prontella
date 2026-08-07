## Project Rules (claude-deck3)

> Added by `/fable-team:grow`. Outside the fable markers so `init` does not overwrite it.

### Verify the discriminator, not just the conclusion

判別器・ランキング・分類の提案は、**誰のものでも(レビュアー・subagent・過去の自分の記録も含めて)
全分岐の実データに当てて真理値表を自分で作ってから**採用する。推奨の結論だけでなく、
**根拠として添えられた事実主張ごと測る**。自分が発注した検証がまだ返っていないうちは、
承認ゲート(ExitPlanMode 等)を開けない。

代表例: レビュアー提案の `%(push)` 空判定は、根拠の「三角ワークフローでは非空」が誤りで、
そのまま実装すれば正常動作中のブランチを別リモートへ誤送信していた(他 4 事例は changelog 2026-07-29)。

@AGENTS.md
