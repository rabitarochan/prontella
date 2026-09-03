import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import type { DropZone } from '../layout/dropZones';
import { loadLeafTermState, saveLeafTermState, type LeafTermState } from '../layout/termState';
import {
  activateSession,
  findTermGroup,
  groupOfSession,
  moveSessionToGroup,
  reorderSession,
  setTermGroupSizes,
  splitWithSession,
  syncSessions,
  type TermGroup,
  type TermGroupNode,
} from '../layout/termGroups';
import type { TermTabDrag } from '../layout/termTabDnd';
import { useTermGroups } from '../layout/useTermGroups';
import { useTileBarSlots } from '../layout/tileBarSlots';
import type { TerminalSession } from '../types';
import ClaudeUsageBar from './ClaudeUsageBar';
import { useConfirm } from './ConfirmDialog';
import SplitTreeView from './SplitTreeView';
import TermGroupPane from './term/TermGroupPane';
import XTermView from './XTermView';

/**
 * タイル内の「ターミナル」ビュー。ファイルパネル (FilesTab + editorGroups) と
 * 同じ 2 段構成:
 *
 *   タイルツリー (leaf.sessions = 所有権)
 *     └ ターミナルグループツリー (layout/termGroups.ts = 所有 ID の分割)
 *          └ グループごとのタブ列 (TermTabsBar) + 本文
 *
 * 所有権は今までどおりタイルツリー側が持つ。ここは leaf.sessions を
 * syncSessions で片方向に取り込むだけで、セッションを作る/殺すのは変わらず
 * useTileLayout のアクション。
 *
 * xterm は FilesTab の Monaco と違い再マウントに耐えられない (WebSocket 再接続と
 * スクロールバック消失) ため、TileGrid.tsx と同じ host-div + createPortal を
 * もう一段導入している: セッションごとに安定した div を 1 つ持ち、XTermView は
 * そこへポータルする。グループを跨ぐ移動も分割も appendChild による DOM の移動
 * にしかならないので、xterm インスタンスは生き続ける。
 *
 * 終了したセッションのタブは (最後の出力を確認できるよう) 手動で閉じるまで残る。
 *
 * ターミナルモニター (TerminalMonitorView) も同じコンポーネントを使う: 所有権の
 * 出所が「タイルの leaf.sessions」から「サーバー上の全 PTY セッション」に変わる
 * だけで、グループ分割・タブ DnD・永続化は共通。そのための差し込み口が
 * defaultState / labelOf / preferGroupFor / webglPolicy と create の第 2 引数。
 */
export interface TermCreateContext {
  /** 「+」「✦」を押したグループ。 */
  groupId: string;
  /** そのグループのアクティブなセッション (モニターは cwd をここから取る)。 */
  activeSessionId: string | null;
}

export default function TermPanel({
  root,
  sessions,
  ownedIds,
  activeId,
  visible,
  leafId,
  onActivate,
  onCloseTab,
  create,
  defaultState,
  labelOf,
  preferGroupFor,
  webglPolicy = 'visible',
}: {
  /** worktree パス。グループツリーの永続化キー。 */
  root: string;
  sessions: TerminalSession[] | null;
  ownedIds: string[];
  activeId: string | null;
  /** このビューが表示中か (アクティブ端末のフォーカス制御用) */
  visible: boolean;
  /** タイルの leaf id。タイルバーのスロット (tileBarSlots) の参照キー。 */
  leafId: string;
  onActivate: (id: string) => void;
  onCloseTab: (id: string) => Promise<void>;
  create: (run: string | undefined, ctx: TermCreateContext) => Promise<void>;
  /** 永続化された状態が無いときの初期グループ構成 (既定は空グループ 1 つ)。 */
  defaultState?: () => LeafTermState | null;
  /** タブ名 (既定はセッションのタイトル)。 */
  labelOf?: (session: TerminalSession) => string;
  /** 新規に現れたセッションの受け皿グループ (null = 「+」を押したグループ / アクティブグループ)。 */
  preferGroupFor?: (sessionId: string, root: TermGroupNode) => string | null;
  /** WebGL を許すターミナル: 'visible' = 表示中の全グループ (既定)、'activeGroup' =
   *  アクティブグループの 1 枚だけ (グループ数が多い画面向け。上限 ~16/タブ)。 */
  webglPolicy?: 'visible' | 'activeGroup';
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const { confirm, dialog } = useConfirm();
  const liveMap = useMemo(
    () => new Map((sessions ?? []).map((s) => [s.id, s])),
    [sessions],
  );

  // Restored exactly once at mount (lazy initializer). Root changes after
  // mount are handled by the root effect below (WorktreeView normally
  // remounts this component via `key`, so that branch is defensive).
  const [initialState] = useState(() => loadLeafTermState(root, leafId) ?? defaultState?.() ?? null);
  const groupsApi = useTermGroups(initialState);
  const { root: groupRoot, activeGroupId } = groupsApi;

  // ---- xterm の安定ホスト -------------------------------------------------

  const hostsRef = useRef(new Map<string, HTMLDivElement>());
  const hostFor = useCallback((id: string): HTMLDivElement => {
    let el = hostsRef.current.get(id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'term-host';
      hostsRef.current.set(id, el);
    }
    return el;
  }, []);

  // タブが閉じた (= ポータルが同じコミットで消える) セッションの host を捨てる。
  useEffect(() => {
    const alive = new Set(ownedIds);
    for (const [id, el] of hostsRef.current) {
      if (!alive.has(id)) {
        el.remove();
        hostsRef.current.delete(id);
      }
    }
  });

  // ---- leaf.sessions への片方向追従 ---------------------------------------

  // 新規セッションの受け皿にしたいグループ (「+」「✦」を押したグループ)。
  // 生成は tileTree 側を経由して ownedIds として返ってくるので、押した瞬間に
  // 覚えておき、到着時の syncSessions の prefer に使う。
  const pendingGroupRef = useRef<string | null>(null);
  const ownedKey = ownedIds.join(',');
  useEffect(() => {
    const st = groupsApi.stateRef.current;
    const prefer = pendingGroupRef.current ?? st.activeGroupId;
    // 「+」を押した直後の到着はそのグループへ (preferGroupFor より優先)。
    const pending = pendingGroupRef.current;
    const next = syncSessions(st.root, ownedIds, prefer, pending ? undefined : preferGroupFor);
    pendingGroupRef.current = null;
    if (next !== st.root) groupsApi.set(next, { activate: prefer });
    // ownedIds の内容が変わったときだけ走らせる (配列の identity は毎回変わる)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownedKey]);

  // アクティブグループのアクティブタブを leaf.activeSession へ押し上げる。
  // TilePane の集約ステータスと DeckView がこれを見ている。逆向き
  // (leaf.activeSession → グループ) は張らない — 追従は常に片方向。
  const focusedSessionId = findTermGroup(groupRoot, activeGroupId)?.activeId ?? null;
  useEffect(() => {
    if (focusedSessionId && focusedSessionId !== activeId) onActivate(focusedSessionId);
    // activeId は「押し上げた結果」なので依存に入れない (入れるとループする)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedSessionId]);

  // ---- 永続化 --------------------------------------------------------------

  const flush = useCallback(
    (flushRoot: string, flushLeafId: string) => {
      const st = groupsApi.stateRef.current;
      saveLeafTermState(flushRoot, flushLeafId, {
        groups: st.root,
        activeGroupId: st.activeGroupId,
      });
    },
    // groupsApi.stateRef は安定
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    flush(root, leafId);
  }, [groupRoot, activeGroupId, root, leafId, flush]);

  const rootEffectRanRef = useRef(false);
  useEffect(() => {
    const flushRoot = root;
    const flushLeafId = leafId;
    if (!rootEffectRanRef.current) {
      rootEffectRanRef.current = true;
    } else {
      groupsApi.reset(loadLeafTermState(root, leafId));
    }
    return () => flush(flushRoot, flushLeafId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, leafId, flush]);

  // ---- 操作 ---------------------------------------------------------------

  const run = (fn: () => Promise<void>) => {
    setBusy(true);
    void fn().finally(() => setBusy(false));
  };

  const closeTab = async (id: string) => {
    if (liveMap.has(id)) {
      const ok = await confirm({
        title: t('term.closeTerminalTitle'),
        message: t('term.closeTerminalMessage'),
        confirmLabel: t('term.closeConfirm'),
        severity: 'danger',
      });
      if (!ok) return;
    }
    // kill + leaf.sessions からの除去はタイル側。グループ側は syncSessions が追従する。
    run(() => onCloseTab(id));
  };

  /** タブストリップへのドロップ: 同一グループ = 並べ替え、別グループ = 移動。
   *  index はドラッグ元タブ込みの並びに対する挿入位置 (同一グループ内で元位置より
   *  右へ挿すときは 1 詰める)。EditorTabsBar/FilesTab と同じ規則。 */
  const dropOnTabStrip = useCallback(
    (dstGroupId: string, index: number, drag: TermTabDrag) => {
      // 別タイルからのドロップは所有権の移転になるので受けない (スコープ外)
      if (drag.sourceLeafId !== leafId) return;
      const st = groupsApi.stateRef.current;
      let at = index;
      if (drag.sourceGroupId === dstGroupId) {
        const g = findTermGroup(st.root, dstGroupId);
        const from = g?.sessions.indexOf(drag.sessionId) ?? -1;
        if (from === -1) return;
        if (from < at) at -= 1;
        if (from === at) {
          groupsApi.setActiveGroup(dstGroupId);
          return;
        }
        groupsApi.set(
          activateSession(reorderSession(st.root, dstGroupId, drag.sessionId, at), dstGroupId, drag.sessionId),
          { activate: dstGroupId },
        );
        return;
      }
      const after = moveSessionToGroup(st.root, drag.sourceGroupId, drag.sessionId, dstGroupId, at);
      groupsApi.set(after, { activate: dstGroupId });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [leafId],
  );

  /** 本文 5 ゾーンへのドロップ: 中央 = そのグループへ移動、上下左右 = その方向へ分割作成。 */
  const dropOnZone = useCallback(
    (dstGroupId: string, zone: DropZone, drag: TermTabDrag) => {
      if (drag.sourceLeafId !== leafId) return;
      const st = groupsApi.stateRef.current;
      if (zone === 'center') {
        if (drag.sourceGroupId === dstGroupId) return;
        groupsApi.set(
          moveSessionToGroup(st.root, drag.sourceGroupId, drag.sessionId, dstGroupId),
          { activate: dstGroupId },
        );
        return;
      }
      const dir = zone === 'left' || zone === 'right' ? 'row' : 'column';
      const before = zone === 'left' || zone === 'top';
      const { root: after, newGroupId } = splitWithSession(
        st.root,
        dstGroupId,
        dir,
        before,
        drag.sessionId,
        drag.sourceGroupId,
      );
      if (newGroupId) groupsApi.set(after, { activate: newGroupId });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [leafId],
  );

  /** タブバーの分割ボタン: アクティブなターミナルを右隣の新グループへ移す
   *  (ファイルタブと違い「複製」はできない — 1 セッション = 1 グループ)。 */
  const splitGroup = useCallback((groupId: string) => {
    const st = groupsApi.stateRef.current;
    const g = findTermGroup(st.root, groupId);
    if (!g?.activeId) return;
    const { root: after, newGroupId } = splitWithSession(
      st.root,
      groupId,
      'row',
      false,
      g.activeId,
      groupId,
    );
    if (newGroupId) groupsApi.set(after, { activate: newGroupId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 描画 ---------------------------------------------------------------

  // 空グループの案内ボタンから作るときの文脈 (押した先は現在のアクティブグループ)
  const emptyCtx = (): TermCreateContext => ({ groupId: activeGroupId, activeSessionId: null });

  const emptyContent: ReactNode =
    sessions === null ? (
      <p>{t('term.connecting')}</p>
    ) : (
      <>
        <p>{t('term.empty')}</p>
        <div className="term-empty-buttons">
          <button disabled={busy} onClick={() => run(() => create(undefined, emptyCtx()))}>
            {t('term.newShellButton')}
          </button>
          <button className="claude" disabled={busy} onClick={() => run(() => create('claude', emptyCtx()))}>
            {t('term.launchClaudeButton')}
          </button>
        </div>
      </>
    );

  const renderGroup = (group: TermGroup) => (
    <TermGroupPane
      key={group.id}
      group={group}
      leafId={leafId}
      liveMap={liveMap}
      busy={busy}
      isActiveGroup={group.id === activeGroupId}
      hostFor={hostFor}
      emptyContent={emptyContent}
      labelOf={labelOf}
      callbacks={{
        onActivate: (id) =>
          groupsApi.set(activateSession(groupsApi.stateRef.current.root, group.id, id), {
            activate: group.id,
          }),
        onCloseTab: (id) => void closeTab(id),
        onCreate: (runCmd) => {
          pendingGroupRef.current = group.id;
          groupsApi.setActiveGroup(group.id);
          run(() => create(runCmd, { groupId: group.id, activeSessionId: group.activeId }));
        },
        onSplit: () => splitGroup(group.id),
        onDropTab: (index, drag) => dropOnTabStrip(group.id, index, drag),
        onDropZone: (zone, drag) => dropOnZone(group.id, zone, drag),
        onFocusGroup: () => groupsApi.setActiveGroup(group.id),
      }}
    />
  );

  // ヘッダー (タイルバー) にはセッションタブではなく Claude の使用量を出す。
  // タブはグループごとに 1 段下がったため、バーの主ゾーンが空いている。
  const barSlot = useTileBarSlots((s) => s.slots[leafId] ?? null);

  // ポータルの描画順は木の走査順に依存させず id で安定ソートする
  // (TileGrid.tsx と同じ理由 — タブの並べ替えやグループ間移動で配列の並びが
  // 変わると、React の再調停で XTermView が remount されうる)。
  const portalIds = [...ownedIds].sort((a, b) => a.localeCompare(b));

  return (
    <div className="term-panel">
      {visible && barSlot && createPortal(<ClaudeUsageBar />, barSlot)}
      <div className="term-body">
        <SplitTreeView<TermGroup>
          node={groupRoot}
          gridClass="term-group-grid"
          panelClass="term-group-panel"
          renderLeaf={renderGroup}
          onSizes={(splitId, sizes) =>
            groupsApi.set(setTermGroupSizes(groupsApi.stateRef.current.root, splitId, sizes))
          }
        />
      </div>
      {portalIds.map((id) =>
        createPortal(
          <XTermView
            id={id}
            claudeMode={liveMap.get(id)?.claudeDetected ?? false}
            visible={visible && groupOfSession(groupRoot, id)?.activeId === id}
            preferWebgl={
              webglPolicy === 'visible' || groupOfSession(groupRoot, id)?.id === activeGroupId
            }
          />,
          hostFor(id),
          id,
        ),
      )}
      {dialog}
    </div>
  );
}
