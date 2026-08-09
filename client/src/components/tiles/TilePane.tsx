import { useCallback, useEffect } from 'react';
import { Check, ChevronDown, FileText, GitBranch, Terminal } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { AgentStatus, TerminalSession } from '../../types';
import type { LeafNode, TileView } from '../../layout/tileTree';
import type { TileActions } from '../../layout/useTileLayout';
import { useConfirm } from '../ConfirmDialog';
import StatusBadge from '../StatusBadge';

const VIEWS: { view: TileView; label: string; Icon: typeof FileText }[] = [
  { view: 'files', label: 'ファイル', Icon: FileText },
  { view: 'git', label: 'Git', Icon: GitBranch },
  { view: 'term', label: 'ターミナル', Icon: Terminal },
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
        title: 'タイルを閉じる',
        message: '未保存の変更があります。タイルを閉じますか?',
        confirmLabel: '閉じる',
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
        {/* ビュー切替: アイコン + プルダウン (P8-3)。旧タブ帯では 3 タブが常時見えて
            いたため、セッション数とステータスはトリガー側に常時出して情報量を保つ */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="tile-view-trigger" title="表示を切り替え">
              <CurrentIcon />
              <span className="tile-tab-label">{current.label}</span>
              {leaf.sessions.length > 0 && (
                <span className="tile-tab-count">{leaf.sessions.length}</span>
              )}
              {termStatus && <StatusBadge status={termStatus} compact />}
              <ChevronDown className="tile-view-chevron" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" onCloseAutoFocus={(e) => e.preventDefault()}>
            {VIEWS.map(({ view, label, Icon }) => (
              <DropdownMenuItem key={view} onSelect={() => actions.setView(leaf.id, view)}>
                <Icon />
                {label}
                {view === 'term' && leaf.sessions.length > 0 && (
                  <span className="tile-tab-count">{leaf.sessions.length}</span>
                )}
                {leaf.view === view && <Check className="ml-auto" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="tile-actions">
          <button
            className="icon-btn"
            title="右に分割"
            onClick={() => actions.split(leaf.id, 'row')}
          >
            <span className="codicon codicon-split-horizontal" />
          </button>
          <button
            className="icon-btn"
            title="下に分割"
            onClick={() => actions.split(leaf.id, 'column')}
          >
            <span className="codicon codicon-split-vertical" />
          </button>
          <button className="icon-btn" title="タイルを閉じる" onClick={() => void close()}>
            <span className="codicon codicon-close" />
          </button>
        </span>
      </header>
      <div className="tile-body" ref={adoptHost} />
      {dialog}
    </section>
  );
}
