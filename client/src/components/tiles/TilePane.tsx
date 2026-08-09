import { useCallback, useEffect } from 'react';
import { Check, ChevronDown, FileText, GitBranch, Terminal } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useT, type StringKey } from '../../i18n';
import type { AgentStatus, TerminalSession } from '../../types';
import type { LeafNode, TileView } from '../../layout/tileTree';
import type { TileActions } from '../../layout/useTileLayout';
import { useConfirm } from '../ConfirmDialog';
import StatusBadge from '../StatusBadge';

const VIEWS: { view: TileView; labelKey: StringKey; Icon: typeof FileText }[] = [
  { view: 'files', labelKey: 'tile.viewFiles', Icon: FileText },
  { view: 'git', labelKey: 'tile.viewGit', Icon: GitBranch },
  { view: 'term', labelKey: 'tile.viewTerm', Icon: Terminal },
];

/** タイル内セッションの「最も注意が必要な」ステータス (デッキのカードと同じ優先順)。 */
function aggregateStatus(leaf: LeafNode, sessions: TerminalSession[] | null): AgentStatus | null {
  const owned = (sessions ?? []).filter((s) => leaf.sessions.includes(s.id));
  if (owned.length === 0) return null;
  const order: AgentStatus[] = ['waiting', 'busy', 'idle', 'shell'];
  for (const status of order) {
    if (owned.some((s) => s.status === status)) return status;
  }
  return null;
}

/**
 * Tile chrome: the header IS the tile's top-level tab bar (files / git /
 * term) plus split/close actions. The body adopts the leaf's stable host
 * element. TilePane itself may be remounted freely by geometry changes —
 * appendChild of the already-parented host is just a move.
 */
export default function TilePane({
  leaf,
  sessions,
  focused,
  actions,
  host,
}: {
  leaf: LeafNode;
  sessions: TerminalSession[] | null;
  focused: boolean;
  actions: TileActions;
  host: HTMLDivElement;
}) {
  const t = useT();
  const { confirm: confirmDialog, dialog } = useConfirm();
  // A DOM move (host re-append after a split/close elsewhere) drops focus;
  // give it back to the focused terminal. Mount-only: focus changes from
  // clicks are handled by the browser itself.
  useEffect(() => {
    if (focused) host.querySelector('textarea')?.focus();
  }, []);

  // Adopt the host node. Must be idempotent: appendChild detaches and
  // re-inserts even under the same parent, which silently drops focus and
  // selection — guard so re-renders (e.g. the 3s status poll) are no-ops.
  const adoptHost = useCallback(
    (el: HTMLDivElement | null) => {
      if (el && host.parentElement !== el) el.appendChild(host);
    },
    [host],
  );

  const close = async () => {
    // FilesTab marks unsaved tabs with .editor-tab-dirty — closing the tile
    // would silently discard those drafts.
    if (host.querySelector('.editor-tab-dirty')) {
      const ok = await confirmDialog({
        title: t('tile.closeTitle'),
        message: t('tile.closeUnsavedMessage'),
        confirmLabel: t('common.close'),
        severity: 'danger',
      });
      if (!ok) return;
    }
    void actions.close(leaf.id);
  };

  const termStatus = aggregateStatus(leaf, sessions);
  const current = VIEWS.find((v) => v.view === leaf.view) ?? VIEWS[0];
  const CurrentIcon = current.Icon;

  return (
    <section
      className={`tile-pane ${focused ? 'focused' : ''}`}
      onMouseDownCapture={() => actions.focusLeaf(leaf.id)}
    >
      <header className="tile-header">
        {/* ビュー切替: アイコン + 小さな▼のみ (モックアップの .view-btn)。
            旧タブ帯では 3 タブが常時見えていたため、セッション数とステータスは
            トリガーの隣に常時出して情報量を保つ */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="tile-view-trigger"
              title={`${t(current.labelKey)} — ${t('tile.switchViewTooltip')}`}
            >
              <CurrentIcon />
              <ChevronDown className="tile-view-chevron" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" onCloseAutoFocus={(e) => e.preventDefault()}>
            {VIEWS.map(({ view, labelKey, Icon }) => (
              <DropdownMenuItem key={view} onSelect={() => actions.setView(leaf.id, view)}>
                <Icon />
                {t(labelKey)}
                {view === 'term' && leaf.sessions.length > 0 && (
                  <span className="tile-tab-count">{leaf.sessions.length}</span>
                )}
                {leaf.view === view && <Check className="ml-auto text-primary" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {leaf.sessions.length > 0 && <span className="tile-tab-count">{leaf.sessions.length}</span>}
        {termStatus && <StatusBadge status={termStatus} dot />}
        <span className="tile-actions">
          <button
            className="icon-btn"
            title={t('tile.splitRightTooltip')}
            onClick={() => actions.split(leaf.id, 'row')}
          >
            <span className="codicon codicon-split-horizontal" />
          </button>
          <button
            className="icon-btn"
            title={t('tile.splitDownTooltip')}
            onClick={() => actions.split(leaf.id, 'column')}
          >
            <span className="codicon codicon-split-vertical" />
          </button>
          <button className="icon-btn" title={t('tile.closeTitle')} onClick={() => void close()}>
            <span className="codicon codicon-close" />
          </button>
        </span>
      </header>
      <div className="tile-body" ref={adoptHost} />
      {dialog}
    </section>
  );
}
