// セッション id → kind ('pty' | 'sdk') のレジストリ。
// /api/terminals の一覧は生きているセッションしか返さないため、終了した
// セッションのタブ (最後の内容を見せるために残す) は kind をここから引く。
// 未知の id は 'pty' 扱い (kind 導入前のレイアウト永続化との互換)。

const kinds = new Map<string, 'pty' | 'sdk'>();

export function recordSessionKinds(sessions: { id: string; kind?: string }[]): void {
  for (const s of sessions) {
    if (s.kind === 'pty' || s.kind === 'sdk') kinds.set(s.id, s.kind);
  }
}

export function sessionKind(id: string): 'pty' | 'sdk' {
  return kinds.get(id) ?? 'pty';
}
