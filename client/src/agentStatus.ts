import { normPath } from './sessionLocate';
import type { AgentStatus, TerminalSession } from './types';

/**
 * worktree のエージェント状態を、/ws/events でプッシュ済みのセッションから導出する純関数。
 *
 * なぜクライアントで導出するか: この値は元々 GET /api/repos のポーリングで運ばれていたが、
 * その間隔を伸ばすとバッジの反映まで遅れてしまう。セッションの顔ぶれと状態は
 * すでに /ws/events で即時にプッシュされている (agentEvents.ts) ので、そちらから
 * 導出すればバッジは即時になり、ポーリングは git 情報だけを運べばよくなる。
 *
 * サーバー側の規則と 1 対 1 で対応させること:
 * - 突合は cwd の **完全一致** (server/pty.ts の list(cwd) / agentSession.ts の list(cwd) は
 *   normalizePath 同士の === で比較する。包含判定・prefix 判定は使っていない)。
 * - 優先順は waiting > busy > idle > shell、該当セッションが無ければ 'none'
 *   (server/pty.ts の aggregateStatus)。
 */
const STATUS_PRIORITY = ['waiting', 'busy', 'idle', 'shell'] as const;

export function resolveAgentStatus(
  sessions: Record<string, TerminalSession>,
  /** /ws/events の snapshot を受信済みか。false の間は sessions を信頼できない。 */
  loaded: boolean,
  worktree: { path: string; agent: { status: AgentStatus } },
): AgentStatus {
  // snapshot 未受信 (未接続・切断中) はポーリング由来の値へフォールバックする。
  // useTerminalSessions.ts が /ws/events の死亡時に API を保険に使うのと同じ方針。
  if (!loaded) return worktree.agent.status;
  const key = normPath(worktree.path);
  const matched = Object.values(sessions).filter((s) => normPath(s.cwd) === key);
  if (matched.length === 0) return 'none';
  for (const status of STATUS_PRIORITY) {
    if (matched.some((s) => s.status === status)) return status;
  }
  return 'shell';
}
