// 1 ターミナルグループ分のセッションタブ列。常にグループ上部にインライン表示する
// (旧 TermPanel はタイルヘッダーへ createPortal して 1 段化していたが、グループ
// 分割でグループごとにタブ列が必要になったため廃止。タイルヘッダーは使用量表示へ)。
//
// タブ DnD: 各タブが draggable で、ドラッグ状態は termTabDnd ストアが正
// (dataTransfer は Firefox 対策のダミー)。ストリップは挿入位置マーカー付きの
// ドロップ先 — 同一グループなら並べ替え、別グループなら移動になる
// (解決は TermPanel 側)。EditorTabsBar.tsx と同じ作りにしてある。

import { useRef, useState } from 'react';
import { useT } from '../../i18n';
import { tabInsertionIndex } from '../../layout/dropZones';
import { useTermTabDnd, type TermTabDrag } from '../../layout/termTabDnd';
import type { TermGroup } from '../../layout/termGroups';
import type { TerminalSession } from '../../types';
import { middleClickAutoscrollGuard, middleClickClose } from '../editorTabs';
import StatusBadge from '../StatusBadge';

export interface TermTabsBarCallbacks {
  onActivate: (sessionId: string) => void;
  onCloseTab: (sessionId: string) => void;
  /** 新規セッション。押されたグループが受け皿になる。 */
  onCreate: (run?: string) => void;
  /** 分割ボタン: アクティブなターミナルを右隣の新グループへ移す。 */
  onSplit: () => void;
  /** ストリップへのドロップ。index はドラッグ元タブ込みの並びに対する挿入位置。 */
  onDropTab: (index: number, drag: TermTabDrag) => void;
}

export default function TermTabsBar({
  leafId,
  group,
  liveMap,
  busy,
  labelOf,
  callbacks,
}: {
  leafId: string;
  group: TermGroup;
  /** 生存セッションの id → 情報。ここに無い id は終了済み (タブだけ残っている)。 */
  liveMap: Map<string, TerminalSession>;
  busy: boolean;
  /** タブ名。既定はセッションのタイトル。ターミナルモニターは worktree 名を出す。 */
  labelOf?: (session: TerminalSession) => string;
  callbacks: TermTabsBarCallbacks;
}) {
  const t = useT();
  const drag = useTermTabDnd((s) => s.drag);
  const dndStart = useTermTabDnd((s) => s.start);
  const dndEnd = useTermTabDnd((s) => s.end);
  const stripRef = useRef<HTMLDivElement>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [markerX, setMarkerX] = useState<number | null>(null);

  const clearMarker = () => {
    setDropIndex(null);
    setMarkerX(null);
  };

  const computeInsertion = (clientX: number): { index: number; x: number } | null => {
    const strip = stripRef.current;
    if (!strip) return null;
    const tabs = Array.from(strip.querySelectorAll<HTMLElement>('.editor-tab'));
    const mids = tabs.map((el) => {
      const r = el.getBoundingClientRect();
      return r.left + r.width / 2;
    });
    const index = tabInsertionIndex(mids, clientX);
    const stripRect = strip.getBoundingClientRect();
    const clientEdge =
      index < tabs.length
        ? tabs[index].getBoundingClientRect().left - 2
        : tabs.length > 0
          ? tabs[tabs.length - 1].getBoundingClientRect().right + 2
          : stripRect.left + 4;
    return { index, x: clientEdge - stripRect.left + strip.scrollLeft };
  };

  const onStripDragOver = (e: React.DragEvent) => {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const ins = computeInsertion(e.clientX);
    if (!ins) return;
    setDropIndex((prev) => (prev === ins.index ? prev : ins.index));
    setMarkerX((prev) => (prev === ins.x ? prev : ins.x));
  };

  const onStripDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const d = drag;
    const index = dropIndex ?? computeInsertion(e.clientX)?.index ?? null;
    clearMarker();
    dndEnd();
    if (d && index !== null) callbacks.onDropTab(index, d);
  };

  return (
    <div className="editor-tabs">
      <div
        className="editor-tabs-strip"
        ref={stripRef}
        {...middleClickAutoscrollGuard}
        onDragOver={onStripDragOver}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) clearMarker();
        }}
        onDrop={onStripDrop}
      >
        {group.sessions.map((id) => {
          const session = liveMap.get(id) ?? null;
          return (
            <div
              key={id}
              className={`editor-tab ${group.activeId === id ? 'active' : ''} ${
                drag?.sessionId === id ? 'dragging' : ''
              }`}
              title={session ? `${session.title} — ${session.cwd}` : t('term.sessionEndedTitle')}
              draggable
              onDragStart={(e) => {
                // dragover 中は getData が読めない (protected mode) ため値は使わないが、
                // Firefox はデータ 0 個だとドラッグ自体を開始しない
                e.dataTransfer.setData('text/plain', id);
                e.dataTransfer.effectAllowed = 'move';
                dndStart({ sourceLeafId: leafId, sourceGroupId: group.id, sessionId: id });
              }}
              onDragEnd={() => {
                // drop の成否に関わらず dragend は必ず発火する (Esc 中断含む) —
                // ストアの残留はここで確実に防ぐ
                clearMarker();
                dndEnd();
              }}
              onClick={() => callbacks.onActivate(id)}
              {...middleClickClose(() => callbacks.onCloseTab(id))}
            >
              <span className="codicon codicon-terminal" />
              <span className="editor-tab-name">
                {session ? (labelOf ? labelOf(session) : session.title) : t('term.endedLabel')}
              </span>
              {session && <StatusBadge status={session.status} dot />}
              <span className="editor-tab-actions">
                <button
                  className="editor-tab-close"
                  title={session ? t('term.closeTerminalTitle') : t('term.closeTabTitle')}
                  onClick={(e) => {
                    e.stopPropagation();
                    callbacks.onCloseTab(id);
                  }}
                >
                  <span className="codicon codicon-close" />
                </button>
              </span>
            </div>
          );
        })}
        {markerX !== null && (
          <div className="editor-tab-insert-marker" style={{ left: `${markerX}px` }} />
        )}
      </div>
      <span className="term-tab-buttons">
        <button
          className="icon-btn"
          title={t('term.newShell')}
          disabled={busy}
          onClick={() => callbacks.onCreate()}
        >
          <span className="codicon codicon-add" />
        </button>
        <button
          className="icon-btn term-claude"
          title={t('term.launchClaudeTitle')}
          disabled={busy}
          onClick={() => callbacks.onCreate('claude')}
        >
          ✦
        </button>
        {group.sessions.length > 1 && (
          <button className="icon-btn" title={t('term.splitTerminalTooltip')} onClick={callbacks.onSplit}>
            <span className="codicon codicon-split-horizontal" />
          </button>
        )}
      </span>
    </div>
  );
}
