import { useEffect, useState } from 'react';
import { enabledServers } from './index';
import type { ServerId } from './languages';
import { getLspSession, type LspStatus } from './session';

export type LspBarStatus = LspStatus | { state: 'builtin' };

/**
 * (root, serverId) の LSP 接続状態 (ステータスバー用)。無効なら TS は 'builtin' (切替の入口を出す)、
 * C# は null (内蔵が無いので off のときは項目そのものを出さない)。
 */
export function useLspStatus(root: string, serverId: ServerId): LspBarStatus | null {
  const [status, setStatus] = useState<LspBarStatus | null>(null);
  useEffect(() => {
    if (!root || !enabledServers.has(serverId)) {
      setStatus(serverId === 'typescript' ? { state: 'builtin' } : null);
      return;
    }
    return getLspSession(root, serverId).subscribe(setStatus);
  }, [root, serverId]);
  return status;
}
