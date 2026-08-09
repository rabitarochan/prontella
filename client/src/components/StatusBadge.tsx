import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useT, type StringKey } from '../i18n';
import type { AgentStatus } from '../types';

// 色はステータストークン (--status-*)。busy/waiting のドット点滅は Tailwind の
// animate-pulse に duration 上書き (旧 CSS: busy 1.2s / waiting 0.6s) で再現する。
const LABELS: Record<AgentStatus, { key: StringKey; className: string; dotClassName?: string }> = {
  busy: {
    key: 'status.busy',
    className: 'border-[var(--status-green)] text-[var(--status-green)]',
    dotClassName: 'animate-pulse [animation-duration:1.2s]',
  },
  waiting: {
    key: 'status.waiting',
    className: 'border-[var(--status-yellow)] text-[var(--status-yellow)]',
    dotClassName: 'animate-pulse [animation-duration:0.6s]',
  },
  idle: { key: 'status.idle', className: 'text-[var(--status-blue)]' },
  shell: { key: 'status.shell', className: 'text-muted-foreground' },
  none: { key: 'status.none', className: 'text-muted-foreground opacity-60' },
};

export default function StatusBadge({
  status,
  compact,
  dot,
}: {
  status: AgentStatus;
  compact?: boolean;
  /** 枠なしの 7px ドットのみ (レールの worktree 行用。モックアップの mini-dot)。 */
  dot?: boolean;
}) {
  const t = useT();
  const { key, className, dotClassName } = LABELS[status] ?? LABELS.none;
  const text = t(key);
  if (dot) {
    return (
      <span
        className={cn('inline-block size-[7px] shrink-0 rounded-full bg-current', className, dotClassName)}
        title={t('status.agentTooltip', { status: text })}
      />
    );
  }
  return (
    <Badge
      variant="outline"
      className={cn('gap-1.5', className)}
      title={t('status.agentTooltip', { status: text })}
    >
      <span className={cn('size-[7px] rounded-full bg-current', dotClassName)} />
      {!compact && text}
    </Badge>
  );
}
