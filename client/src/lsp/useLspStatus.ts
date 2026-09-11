import { useEffect, useState } from 'react';
import { lspEnabled } from './index';
import { getLspSession, type LspStatus } from './session';

/** root の LSP 接続状態 (ステータスバー用)。LSP 無効なら null。 */
export function useLspStatus(root: string): LspStatus | null {
  const [status, setStatus] = useState<LspStatus | null>(null);
  useEffect(() => {
    if (!lspEnabled || !root) {
      setStatus(null);
      return;
    }
    return getLspSession(root).subscribe(setStatus);
  }, [root]);
  return status;
}
