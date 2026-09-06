import { useEffect, useState } from 'react';

// VS Code タイルはサーバー側の PRONTELLA_VSCODE_TILE=1 でのみ生える。
// 無効時は API 自体が存在しない (404) ので、その到達性でそのまま判定する。
// プロセス内で一度だけ問い合わせて共有する。
let probe: Promise<boolean> | null = null;

function probeEnabled(): Promise<boolean> {
  probe ??= fetch('/api/vscode/status')
    .then((r) => r.ok)
    .catch(() => false);
  return probe;
}

export function useVsCodeEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let alive = true;
    void probeEnabled().then((ok) => {
      if (alive) setEnabled(ok);
    });
    return () => {
      alive = false;
    };
  }, []);
  return enabled;
}
