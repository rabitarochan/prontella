import { useEffect, useState } from 'react';
import { lspEnabled } from './index';
import { getLspSession, type LspStatus } from './session';

export type LspBarStatus = LspStatus | { state: 'builtin' };

/** root の LSP 接続状態 (ステータスバー用)。LSP 無効 (mode = builtin) なら 'builtin'。 */
export function useLspStatus(root: string): LspBarStatus | null {
  const [status, setStatus] = useState<LspBarStatus | null>(null);
  useEffect(() => {
    if (!lspEnabled || !root) {
      setStatus(lspEnabled ? null : { state: 'builtin' });
      return;
    }
    return getLspSession(root).subscribe(setStatus);
  }, [root]);
  return status;
}
