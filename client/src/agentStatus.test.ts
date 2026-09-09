import { describe, expect, it } from 'vitest';
import { resolveAgentStatus } from './agentStatus';
import type { AgentStatus, TerminalSession } from './types';

function session(cwd: string, status: AgentStatus, id = cwd + ':' + status): TerminalSession {
  return {
    id, cwd, title: 't', kind: 'pty', status, claudeDetected: true,
    createdAt: 0, lastOutputAt: 0, statusSince: 0, activity: null,
  };
}
const map = (...list: TerminalSession[]) => Object.fromEntries(list.map((s) => [s.id, s]));
const wt = (path: string, fallback: AgentStatus = 'none') => ({ path, agent: { status: fallback } });

describe('resolveAgentStatus', () => {
  it('該当セッションが無ければ none', () => {
    expect(resolveAgentStatus(map(session('C:/x/other', 'busy')), true, wt('C:/x/repo'))).toBe('none');
  });

  it('優先順は waiting > busy > idle > shell', () => {
    const all = map(
      session('C:/x/repo', 'shell'),
      session('C:/x/repo', 'idle'),
      session('C:/x/repo', 'busy'),
      session('C:/x/repo', 'waiting'),
    );
    expect(resolveAgentStatus(all, true, wt('C:/x/repo'))).toBe('waiting');
    const noWaiting = map(session('C:/x/repo', 'shell'), session('C:/x/repo', 'idle'), session('C:/x/repo', 'busy'));
    expect(resolveAgentStatus(noWaiting, true, wt('C:/x/repo'))).toBe('busy');
    const idleShell = map(session('C:/x/repo', 'shell'), session('C:/x/repo', 'idle'));
    expect(resolveAgentStatus(idleShell, true, wt('C:/x/repo'))).toBe('idle');
    expect(resolveAgentStatus(map(session('C:/x/repo', 'shell')), true, wt('C:/x/repo'))).toBe('shell');
  });

  it('パス表記の揺れ (区切り文字・大小文字・末尾スラッシュ) を吸収する', () => {
    const s = map(session('c:\\x\\repo\\', 'busy'));
    expect(resolveAgentStatus(s, true, wt('C:/x/repo'))).toBe('busy');
  });

  it('包含・prefix では突合しない (サーバーと同じ完全一致)', () => {
    // repo の下位ディレクトリーで起動したセッションはサーバーでも数えられない
    expect(resolveAgentStatus(map(session('C:/x/repo/sub', 'busy')), true, wt('C:/x/repo'))).toBe('none');
    // 兄弟リポジトリーへの誤爆もしない
    expect(resolveAgentStatus(map(session('C:/x/repo-old', 'busy')), true, wt('C:/x/repo'))).toBe('none');
  });

  it('snapshot 未受信ならポーリング由来の値へフォールバックする', () => {
    // sessions が空でも loaded=false ならフォールバック値を返す (誤って none にしない)
    expect(resolveAgentStatus({}, false, wt('C:/x/repo', 'busy'))).toBe('busy');
    // loaded=true なら空はそのまま none
    expect(resolveAgentStatus({}, true, wt('C:/x/repo', 'busy'))).toBe('none');
  });

  it('sdk (チャット) セッションも同じ worktree として数える', () => {
    const sdk = { ...session('C:/x/repo', 'busy'), kind: 'sdk' as const };
    expect(resolveAgentStatus(map(sdk), true, wt('C:/x/repo'))).toBe('busy');
  });
});
