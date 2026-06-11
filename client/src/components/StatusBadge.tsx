import type { AgentStatus } from '../types';

const LABELS: Record<AgentStatus, { text: string; cls: string }> = {
  busy: { text: '実行中', cls: 'badge-busy' },
  waiting: { text: '確認待ち', cls: 'badge-waiting' },
  idle: { text: '待機中', cls: 'badge-idle' },
  shell: { text: 'シェル', cls: 'badge-shell' },
  none: { text: '未起動', cls: 'badge-none' },
};

export default function StatusBadge({ status, compact }: { status: AgentStatus; compact?: boolean }) {
  const { text, cls } = LABELS[status] ?? LABELS.none;
  return (
    <span className={`badge ${cls}`} title={`エージェント: ${text}`}>
      <span className="badge-dot" />
      {!compact && text}
    </span>
  );
}
