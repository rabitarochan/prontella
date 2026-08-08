import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { AgentStatus } from '../types';

// 色はステータストークン (--status-*)。busy/waiting のドット点滅は Tailwind の
// animate-pulse に duration 上書き (旧 CSS: busy 1.2s / waiting 0.6s) で再現する。
const LABELS: Record<AgentStatus, { text: string; className: string; dotClassName?: string }> = {
  busy: {
    text: '実行中',
    className: 'border-[var(--status-green)] text-[var(--status-green)]',
    dotClassName: 'animate-pulse [animation-duration:1.2s]',
  },
  waiting: {
    text: '確認待ち',
    className: 'border-[var(--status-yellow)] text-[var(--status-yellow)]',
    dotClassName: 'animate-pulse [animation-duration:0.6s]',
  },
  idle: { text: '待機中', className: 'text-[var(--status-blue)]' },
  shell: { text: 'シェル', className: 'text-muted-foreground' },
  none: { text: '未起動', className: 'text-muted-foreground opacity-60' },
};

export default function StatusBadge({ status, compact }: { status: AgentStatus; compact?: boolean }) {
  const { text, className, dotClassName } = LABELS[status] ?? LABELS.none;
  return (
    <Badge variant="outline" className={cn('gap-1.5', className)} title={`エージェント: ${text}`}>
      <span className={cn('size-[7px] rounded-full bg-current', dotClassName)} />
      {!compact && text}
    </Badge>
  );
}
