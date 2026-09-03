import { equalSizes, newId } from './splitTree';
import { allTermGroups, makeTermGroup, type TermGroupNode } from './termGroups';
import type { LeafTermState } from './termState';
import type { TerminalSession } from '../types';

/** ターミナルモニターのグループツリー永続化キー (termState は worktree パスで引くので擬似パス)。 */
export const MONITOR_TERM_ROOT = '__monitor__';
export const MONITOR_LEAF_ID = 'monitor';

export interface MonitorEntry {
  /** 表示ラベル (sessionLabel の結果: "repo / branch" 等)。整列キーにも使う。 */
  label: string;
  session: TerminalSession;
}

/**
 * ターミナルモニターに並べるセッションを決める純関数。
 * PTY セッションのみ (SDK チャットは対象外)。同じ worktree の端末が隣り合うように
 * ラベル → 作成順 → id で安定整列する (ステータスで並べ替えると更新のたびに
 * タブが飛び回り、視線が追えなくなる)。
 */
export function orderMonitorSessions(
  sessions: TerminalSession[],
  labelOf: (session: TerminalSession) => string,
): MonitorEntry[] {
  return sessions
    .filter((s) => s.kind === 'pty')
    .map((session) => ({ label: labelOf(session), session }))
    .sort(
      (a, b) =>
        a.label.localeCompare(b.label) ||
        a.session.createdAt - b.session.createdAt ||
        a.session.id.localeCompare(b.session.id),
    );
}

/** 正規化した cwd で「同じ worktree」を判定する (パス表記の揺れ・大文字小文字を吸収)。 */
export function sameWorktreeKey(cwd: string): string {
  return cwd.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * 永続化された状態が無いときの初期構成: worktree ごとに 1 グループ。
 * 3 つまでは横並び、それ以上は ceil(sqrt(n)) 列のグリッド (行の縦分割 × 各行の横分割)。
 * セッションが無ければ null (TermPanel の既定 = 空グループ 1 つ)。
 */
export function initialMonitorTermState(entries: MonitorEntry[]): LeafTermState | null {
  if (entries.length === 0) return null;
  const byWorktree = new Map<string, string[]>();
  for (const { session } of entries) {
    const key = sameWorktreeKey(session.cwd);
    const ids = byWorktree.get(key);
    if (ids) ids.push(session.id);
    else byWorktree.set(key, [session.id]);
  }
  const groups = [...byWorktree.values()].map((ids) => makeTermGroup(ids, ids[0]));
  const n = groups.length;
  const row = (nodes: TermGroupNode[]): TermGroupNode =>
    nodes.length === 1
      ? nodes[0]
      : { type: 'split', id: newId(), dir: 'row', sizes: equalSizes(nodes.length), children: nodes };
  let root: TermGroupNode;
  if (n <= 3) {
    root = row(groups);
  } else {
    const cols = Math.ceil(Math.sqrt(n));
    const rows: TermGroupNode[] = [];
    for (let i = 0; i < n; i += cols) rows.push(row(groups.slice(i, i + cols)));
    root = { type: 'split', id: newId(), dir: 'column', sizes: equalSizes(rows.length), children: rows };
  }
  return { groups: root, activeGroupId: groups[0].id };
}

/**
 * 新しく現れたセッションの受け皿: 同じ worktree のセッションを既に持つグループ。
 * 無ければ null (TermPanel の既定へ)。
 */
export function monitorGroupFor(
  sessionId: string,
  root: TermGroupNode,
  liveMap: Map<string, TerminalSession>,
): string | null {
  const session = liveMap.get(sessionId);
  if (!session) return null;
  const key = sameWorktreeKey(session.cwd);
  for (const g of allTermGroups(root)) {
    for (const id of g.sessions) {
      const other = liveMap.get(id);
      if (other && id !== sessionId && sameWorktreeKey(other.cwd) === key) return g.id;
    }
  }
  return null;
}
