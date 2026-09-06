import { useCallback, useEffect, useState } from 'react';
import { Check, ChevronDown, Code2, FileText, GitBranch, GripVertical, MessageSquare, Terminal } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useT, type StringKey } from '../../i18n';
import type { AgentStatus, TerminalSession } from '../../types';
import { sessionKind } from '../../layout/sessionKinds';
import { zoneFromPoint } from '../../layout/dropZones';
import { LEAD_SLOT_SUFFIX, useTileBarSlots } from '../../layout/tileBarSlots';
import { useTileDnd } from '../../layout/tileDnd';
import type { LeafNode, TileView } from '../../layout/tileTree';
import type { TileActions, TileDropZone } from '../../layout/useTileLayout';
import { useConfirm } from '../ConfirmDialog';
import StatusBadge from '../StatusBadge';
import { useVsCodeEnabled } from '../vscode/useVsCodeEnabled';

const VIEWS: { view: TileView; labelKey: StringKey; Icon: typeof FileText }[] = [
  { view: 'files', labelKey: 'tile.viewFiles', Icon: FileText },
  { view: 'git', labelKey: 'tile.viewGit', Icon: GitBranch },
  { view: 'term', labelKey: 'tile.viewTerm', Icon: Terminal },
  { view: 'chat', labelKey: 'tile.viewChat', Icon: MessageSquare },
  // VS Code は PRONTELLA_VSCODE_TILE=1 のときだけメニューに出す。VIEWS 自体からは
  // 外さない — 保存済みレイアウトが code のときに現在ビューを解決できなくなるため。
  { view: 'code', labelKey: 'tile.viewCode', Icon: Code2 },
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
  const vscodeEnabled = useVsCodeEnabled();
  const { confirm: confirmDialog, dialog } = useConfirm();
  const setSlot = useTileBarSlots((s) => s.setSlot);
  const clearSlot = useTileBarSlots((s) => s.clearSlot);
  // DnD レイアウト再構成: ドラッグ中はドロップ先候補の全タイルに 5 ゾーンの
  // オーバーレイを出す (VS Code のタブ DnD と同じ UX)。
  const draggingId = useTileDnd((s) => s.draggingId);
  const dndStart = useTileDnd((s) => s.start);
  const dndEnd = useTileDnd((s) => s.end);
  const [dropZone, setDropZone] = useState<TileDropZone | null>(null);
  const isDragSource = draggingId === leaf.id;
  const isDropTarget = draggingId !== null && !isDragSource;

  const onHeaderDragStart = (e: React.DragEvent) => {
    const el = e.target as HTMLElement;
    // グリップ以外の対話要素 (ボタン・タブ等) からのドラッグは無効にして
    // クリック操作を優先する。ヘッダーの空き領域とグリップだけがハンドル。
    if (
      !el.closest('.tile-drag-handle') &&
      el.closest('button, input, .editor-tab, [data-slot]')
    ) {
      e.preventDefault();
      return;
    }
    // dragover 中は getData が読めない (protected mode) ため値は使わないが、
    // Firefox はデータ 0 個だとドラッグ自体を開始しない
    e.dataTransfer.setData('text/plain', leaf.id);
    e.dataTransfer.effectAllowed = 'move';
    dndStart(leaf.id);
  };

  const zoneFromEvent = (e: React.DragEvent): TileDropZone =>
    zoneFromPoint(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY);
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
  // ドロップダウンのセッション数は kind で振り分ける (term = pty / chat = sdk)
  const ptyCount = leaf.sessions.filter((id) => sessionKind(id) !== 'sdk').length;
  const chatCount = leaf.sessions.length - ptyCount;
  // chat ビューではセッションタブ自体がバーに入る (ドット付き) ため、先頭ゾーンの
  // 集約カウント / ステータスドットは他ビュー表示中のみ出す。term ビューのタブは
  // グループごとに 1 段下がった (バーには使用量表示が入る) ので対象外。
  const tabsInBar = leaf.view === 'chat';
  const current = VIEWS.find((v) => v.view === leaf.view) ?? VIEWS[0];
  // 無効時は VS Code を選択肢から隠す (既に code のタイルはそのまま動く)
  const menuViews = VIEWS.filter((v) => v.view !== 'code' || vscodeEnabled);
  const CurrentIcon = current.Icon;

  return (
    <section
      className={`tile-pane ${focused ? 'focused' : ''} ${isDragSource ? 'dragging' : ''}`}
      onMouseDownCapture={() => actions.focusLeaf(leaf.id)}
    >
      <header
        className="tile-header"
        draggable
        onDragStart={onHeaderDragStart}
        onDragEnd={dndEnd}
      >
        {/* 先頭ゾーン: ビュー切替 + (files ビュー時) ツリー列ヘッダーのポータル先。
            かつては --files-tree-w でツリー列幅に揃えていたが、ツリー列は
            react-resizable-panels でユーザーが動かせるようになったため固定幅は廃止した
            (ヘッダーは内容ぶんの幅で流れる) */}
        <div className="tile-header-lead">
          <span className="tile-drag-handle" title={t('tile.dragHint')}>
            <GripVertical />
          </span>
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
              {menuViews.map(({ view, labelKey, Icon }) => (
                <DropdownMenuItem key={view} onSelect={() => actions.setView(leaf.id, view)}>
                  <Icon />
                  {t(labelKey)}
                  {view === 'term' && ptyCount > 0 && (
                    <span className="tile-tab-count">{ptyCount}</span>
                  )}
                  {view === 'chat' && chatCount > 0 && (
                    <span className="tile-tab-count">{chatCount}</span>
                  )}
                  {leaf.view === view && <Check className="ml-auto text-primary" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {!tabsInBar && leaf.sessions.length > 0 && (
            <span className="tile-tab-count">{leaf.sessions.length}</span>
          )}
          {!tabsInBar && termStatus && <StatusBadge status={termStatus} dot />}
          <span
            className="tile-bar-slot tile-bar-slot-lead"
            ref={(el) => {
              if (!el) return;
              const key = leaf.id + LEAD_SLOT_SUFFIX;
              setSlot(key, el);
              return () => clearSlot(key, el);
            }}
          />
        </div>
        {/* メインゾーン: パネル側 (FilesTab 等) が createPortal でヘッダー UI を
            差し込むスロット。TilePane は remount 自由なため、登録はストア経由 */}
        <span
          className="tile-bar-slot"
          ref={(el) => {
            if (!el) return;
            setSlot(leaf.id, el);
            return () => clearSlot(leaf.id, el);
          }}
        />
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
      {/* ドロップ先オーバーレイ: ドラッグ中のみタイル全面を覆い、5 ゾーン
          (上下左右 = 分割挿入 / 中央 = 位置交換) のインジケーターを出す。
          全面で dragover を受けるので xterm/Monaco がイベントを奪うことはない */}
      {isDropTarget && (
        <div
          className="tile-drop-overlay"
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const z = zoneFromEvent(e);
            setDropZone((prev) => (prev === z ? prev : z));
          }}
          onDragLeave={() => setDropZone(null)}
          onDrop={(e) => {
            e.preventDefault();
            const src = draggingId;
            const zone = dropZone ?? zoneFromEvent(e);
            setDropZone(null);
            dndEnd();
            if (src) actions.move(src, leaf.id, zone);
          }}
        >
          {dropZone && <div className={`tile-drop-indicator zone-${dropZone}`} />}
        </div>
      )}
      {dialog}
    </section>
  );
}
