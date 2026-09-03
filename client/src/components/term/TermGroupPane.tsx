// 1 ターミナルグループ = タブ列 + 本文 (xterm ホストの受け皿) + アクティビティバー。
//
// 本文は「自分のグループが持つ全セッションの host div を appendChild する」だけ。
// host は TermPanel が id ごとに 1 つだけ作る安定 DOM ノードで、その中身は
// createPortal された XTermView。グループ間の移動もタイルの分割も appendChild に
// よる DOM の移動になるので、xterm は remount されない (= WebSocket もスクロール
// バックも無傷)。TileGrid.tsx / TilePane.adoptHost と同じパターン。

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { zoneFromPoint, type DropZone } from '../../layout/dropZones';
import type { TermGroup } from '../../layout/termGroups';
import { useTermTabDnd, type TermTabDrag } from '../../layout/termTabDnd';
import type { TerminalSession } from '../../types';
import AgentActivityStrip from '../AgentActivityStrip';
import TermTabsBar, { type TermTabsBarCallbacks } from './TermTabsBar';

export interface TermGroupCallbacks extends TermTabsBarCallbacks {
  /** 本文 5 ゾーンへのドロップ (中央 = 移動、上下左右 = その方向へ分割作成)。 */
  onDropZone: (zone: DropZone, drag: TermTabDrag) => void;
  onFocusGroup: () => void;
}

export default function TermGroupPane({
  group,
  leafId,
  liveMap,
  busy,
  isActiveGroup,
  hostFor,
  emptyContent,
  labelOf,
  callbacks,
}: {
  group: TermGroup;
  leafId: string;
  liveMap: Map<string, TerminalSession>;
  busy: boolean;
  isActiveGroup: boolean;
  /** タブ名 (TermTabsBar へ委譲)。 */
  labelOf?: (session: TerminalSession) => string;
  /** セッション id → 安定 host div (TermPanel が所有)。 */
  hostFor: (sessionId: string) => HTMLDivElement;
  /** タブが 1 枚も無いグループの本文 (接続中 / 新規作成の案内)。 */
  emptyContent: ReactNode;
  callbacks: TermGroupCallbacks;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const drag = useTermTabDnd((s) => s.drag);
  const dndEnd = useTermTabDnd((s) => s.end);
  const [dropZone, setDropZone] = useState<DropZone | null>(null);

  // このグループが持つ host を本文へ取り込む。appendChild は同じ親の下でも
  // 一度切り離して挿し直すため、フォーカスと選択が黙って落ちる — 親が既に
  // 自分なら触らない冪等ガードが必須 (TilePane.adoptHost と同じ理由)。
  const sessionKey = group.sessions.join(',');
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    for (const id of group.sessions) {
      const host = hostFor(id);
      if (host.parentElement !== body) body.appendChild(host);
    }
    // 他グループへ移った host は、移動先の同じ effect が appendChild で
    // 引き取る (appendChild は元の親から自動で外す) ので後始末は不要。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey, hostFor]);

  const active = group.activeId;
  const activity = (active ? liveMap.get(active)?.activity : null) ?? null;
  const showActivity =
    activity !== null && (activity.tool !== null || activity.subagents.length > 0);

  const zoneFromEvent = (e: React.DragEvent): DropZone =>
    zoneFromPoint(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY);

  return (
    <section
      className={`term-group ${isActiveGroup ? 'active' : ''}`}
      onMouseDownCapture={callbacks.onFocusGroup}
    >
      <TermTabsBar
        leafId={leafId}
        group={group}
        liveMap={liveMap}
        busy={busy}
        labelOf={labelOf}
        callbacks={callbacks}
      />
      <div className="term-group-body" ref={bodyRef}>
        {group.sessions.length === 0 && <div className="term-empty">{emptyContent}</div>}
        {/* ドラッグ中だけ全面を覆う。全面で dragover を受けるので xterm が
            イベントを奪うことはない (TilePane のタイル DnD と同じ作り)。
            別タイルからのドラッグは受けない (所有権の移転になるためスコープ外) —
            オーバーレイ自体を出さないことで「落とせそうに見えて何も起きない」を防ぐ */}
        {drag !== null && drag.sourceLeafId === leafId && (
          <div
            className="editor-drop-overlay"
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              const z = zoneFromEvent(e);
              setDropZone((prev) => (prev === z ? prev : z));
            }}
            onDragLeave={() => setDropZone(null)}
            onDrop={(e) => {
              e.preventDefault();
              const d = drag;
              const zone = dropZone ?? zoneFromEvent(e);
              setDropZone(null);
              dndEnd();
              if (d) callbacks.onDropZone(zone, d);
            }}
          >
            {dropZone && <div className={`tile-drop-indicator zone-${dropZone}`} />}
          </div>
        )}
      </div>
      {showActivity && activity && (
        <div className="term-statusbar">
          <AgentActivityStrip
            tool={activity.tool}
            toolSince={activity.toolSince}
            subagents={activity.subagents}
          />
        </div>
      )}
    </section>
  );
}
