// ファイルパネルのコーディネーター。エディターグループ分割 (VS Code のエディター
// グループ相当) の導入に伴い、実体は components/files/ 配下へ分離した:
// - editorGroups.ts   … グループツリーの純関数 (vitest 対象)
// - useEditorGroups   … ツリー + アクティブグループの状態
// - useFileEntries    … ファイル実行時状態のプール (path/kind 単位、グループ横断共有)
// - EditorGroupPane   … 1 グループの UI (タブバー + Monaco/プレビュー)
// - GroupSplitView    … react-resizable-panels の再帰ジオメトリ
// FilesTab 自身はサイドペイン (ツリー/検索)・モーダル・ホットキー registry・
// 「操作 → 木の変換 → リソース破棄 → 永続化」のオーケストレーションだけを持つ。

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  hashText,
  loadLeafEditorState,
  MAX_DRAFT_TEXT_LENGTH,
  MAX_OPEN_FILES,
  refKey,
  saveLeafEditorState,
  tabKey,
  type LeafEditorState,
  type TabKind,
} from '../editorState';
import { useT, type StringKey } from '../i18n';
import { isMarkdownPath } from '../markdown/paths';
import { registerFilesTab, touchFilesTab, unregisterFilesTab } from '../search/registry';
import BlameModal from './BlameModal';
import { useConfirm } from './ConfirmDialog';
import ContextMenu, { type ContextMenuItem } from './ContextMenu';
import EditorStatusBar from './EditorStatusBar';
import { basename } from './editorTabs';
import FileHistoryModal from './FileHistoryModal';
import FileTree, { type FileTreeHandle } from './FileTree';
import SearchPanel from './SearchPanel';
import type { DropZone } from '../layout/dropZones';
import type { EditorTabDrag } from '../layout/editorTabDnd';
import {
  activateTab,
  allGroups,
  closeTabInGroup,
  distinctKeys,
  distinctRefs,
  findGroup,
  groupsWithKey,
  insertTabInGroup,
  moveTabToGroup,
  openTabInGroup,
  orphanedKeysAfter,
  pickEviction,
  setGroupSizes,
  splitWithTab,
  type GroupNode,
} from './files/editorGroups';
import {
  getTransferHandle,
  registerTransferHandle,
  sanitizeTransferPayload,
  unregisterTransferHandle,
  type TabTransferPayload,
} from './files/transferRegistry';
import EditorGroupPane, { type PaneHandle, type PaneShared } from './files/EditorGroupPane';
import GroupSplitView from './files/GroupSplitView';
import { disposeModelsSoon } from './files/monacoSave';
import { useEditorGroups } from './files/useEditorGroups';
import { isDirtyEntry, useFileEntries, type MonacoEditor } from './files/useFileEntries';

// sanitizeEditorState (editorState.ts) silently drops any draft over
// MAX_DRAFT_TEXT_LENGTH on restore, so a draft that big is invisible to the
// user unless flagged explicitly here. Holds the StringKey (not the resolved
// text) so translate() can resolve it at render time — this constant also
// doubles as the sentinel value compared against below, so the field itself
// stays a StringKey end to end.
const OVERSIZE_DRAFT_WARNING: StringKey = 'files.oversizeDraftWarning';

export default function FilesTab({
  root,
  leafId,
}: {
  root: string;
  leafId: string;
  /** このタイルが現在ファイルビューを表示中か (TileWorkspace の display 切替)。
   *  タブバーは常にグループ内インラインなので描画上は未使用。 */
  visible?: boolean;
}) {
  const t = useT();
  // useConfirm 側は confirmDialog という別名にする (GitTab.tsx と同じ命名)。
  const { confirm: confirmDialog, dialog } = useConfirm();

  // Restored exactly once at mount (lazy initializer — NOT re-evaluated on
  // re-render). Root changes after mount are handled explicitly by the root
  // effect below, which re-reads storage itself.
  const [initialState] = useState<LeafEditorState | null>(() => loadLeafEditorState(root, leafId));
  const groupsApi = useEditorGroups(initialState);
  const entriesApi = useFileEntries(root, leafId, {
    refs: initialState ? distinctRefs(initialState.groups) : [],
    drafts: initialState?.drafts ?? {},
    viewStates: initialState?.viewStates ?? {},
  });

  const containerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef(root);
  rootRef.current = root;
  const leafIdRef = useRef(leafId);
  leafIdRef.current = leafId;

  // Per-mount id for the Ctrl+P/Ctrl+Shift+F hotkey registry (search/registry.ts) only.
  // (モデル URI の名前空間は leafId — useFileEntries.modelPath を参照。)
  const instanceRef = useRef(crypto.randomUUID().slice(0, 8));

  const paneHandlesRef = useRef(new Map<string, PaneHandle>());
  const [editorInsts, setEditorInsts] = useState<Record<string, MonacoEditor | null>>({});
  const pendingRevealRef = useRef<{ path: string; line: number; column: number } | null>(null);

  // Left pane: file tree or the Ctrl+Shift+F search panel. The panel stays
  // mounted after first visit (display:none) so query and results survive
  // switching back to the tree — same idea as TileWorkspace's visitedRef.
  const [side, setSide] = useState<'tree' | 'search'>('tree');
  const [searchFocusSeq, setSearchFocusSeq] = useState(0);
  const searchVisitedRef = useRef(false);
  if (side === 'search') searchVisitedRef.current = true;

  // ファイルツリーの右クリックメニュー(「ファイルの履歴...」等)。読み取り専用機能なので
  // ConfirmDialog は不要 — pj-git-route の「操作系でない機能は確認不要」の原則どおり。
  const [fileMenu, setFileMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [historyPath, setHistoryPath] = useState<string | null>(null);
  const [blamePath, setBlamePath] = useState<string | null>(null);
  const treeCtl = useRef<FileTreeHandle | null>(null);

  // ---- 永続化 --------------------------------------------------------------

  /** 全ペインのアクティブタブの viewState を退避する。木の構造変更・flush の直前に呼ぶ。 */
  const stashAll = useCallback(() => {
    for (const h of paneHandlesRef.current.values()) h.stash();
  }, []);

  // drafts are computed fresh from the live entries on every flush (not read
  // back out of draftsRef, which only ever holds RESTORED entries not yet
  // reconciled by loadFile):
  //   - loaded, editable, dirty entries → the live draft text + a hash of the
  //     disk content it was based on (baseHash). Skipped over MAX_DRAFT_TEXT_LENGTH
  //     (sanitizeEditorState would drop it on restore anyway — symmetric by
  //     construction, both reference the same constant).
  //   - still-loading entries (file === null) → whatever restored draft
  //     draftsRef still has pending, carried through as-is.
  //   - loaded binary/tooLarge/clean entries → omitted entirely.
  const computeDrafts = useCallback((): Record<string, { text: string; baseHash: string }> => {
    const drafts: Record<string, { text: string; baseHash: string }> = {};
    for (const key of distinctKeys(groupsApi.stateRef.current.root)) {
      const e = entriesApi.entriesRef.current[key];
      if (!e || e.kind !== 'editor') continue;
      if (e.file === null) {
        const pending = entriesApi.draftsRef.current[e.path];
        if (pending) drafts[e.path] = pending;
      } else if (e.file.content !== null && isDirtyEntry(e) && e.draft.length <= MAX_DRAFT_TEXT_LENGTH) {
        drafts[e.path] = { text: e.draft, baseHash: hashText(e.file.content) };
      }
    }
    return drafts;
    // groupsApi.stateRef / entriesApi refs are stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Write the current state to localStorage under (flushRoot, flushLeafId).
  // Root/leafId are passed as arguments (not read from the closure) so callers
  // — the root-change/unmount cleanup in particular — always target the
  // worktree the flushed state actually belongs to.
  const flush = useCallback(
    (flushRoot: string, flushLeafId: string) => {
      stashAll();
      const { root: groupRoot, activeGroupId } = groupsApi.stateRef.current;
      saveLeafEditorState(flushRoot, flushLeafId, {
        groups: groupRoot,
        activeGroupId,
        viewStates: entriesApi.viewStatesRef.current,
        drafts: computeDrafts(),
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stashAll, computeDrafts],
  );

  // ---- 木の変換 + リソースライフサイクル -----------------------------------

  // Apply a group-tree transition: set the new tree, dispose resources whose
  // LAST reference disappeared (orphanedKeysAfter — derived ref counting), and
  // clean group-scoped state (viewStates / editor instances) of removed groups.
  const applyGroups = useCallback(
    (after: GroupNode, opts?: { activate?: string }) => {
      const before = groupsApi.stateRef.current.root;
      if (after === before) {
        if (opts?.activate) groupsApi.setActiveGroup(opts.activate);
        return;
      }
      groupsApi.set(after, opts);
      const orphans = orphanedKeysAfter(before, after);
      if (orphans.length > 0) entriesApi.disposeKeys(orphans);
      const goneIds = new Set(allGroups(before).map((g) => g.id));
      for (const g of allGroups(after)) goneIds.delete(g.id);
      for (const gone of goneIds) {
        delete entriesApi.viewStatesRef.current[gone];
        paneHandlesRef.current.delete(gone);
        setEditorInsts((prev) => {
          if (!(gone in prev)) return prev;
          const next = { ...prev };
          delete next[gone];
          return next;
        });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // ---- タブ操作 ------------------------------------------------------------

  // Open a tab in the active group: focus it if already open there, otherwise
  // add it and load it. A key already open in ANOTHER group still opens here
  // too (VS Code 同様) — the pool entry and Monaco model are shared.
  const openTab = useCallback(
    (kind: TabKind, path: string) => {
      stashAll();
      entriesApi.setMessage('');
      const key = tabKey(kind, path);
      const st = groupsApi.stateRef.current;
      const groupId = st.activeGroupId;
      const before = st.root;
      let after = openTabInGroup(before, groupId, { kind, path });
      // Auto-close the single oldest entry that's safe to lose once the pool
      // would exceed MAX_OPEN_FILES: not dirty (an unsaved edit must never be
      // silently discarded), not any group's current active tab, not the tab
      // being opened, and never a key open in 2+ groups (closing one reference
      // frees nothing). `file !== null` is required too — a still-loading OR
      // load-FAILED entry always looks non-dirty even though it may be carrying
      // a restored draft that loadFile hasn't reconciled yet; evicting it would
      // silently drop that draft on the next flush. If every entry is dirty or
      // unresolved, the cap is exceeded rather than discarding anything.
      if (distinctKeys(after).length > MAX_OPEN_FILES) {
        const activeKeys = allGroups(before)
          .map((g) => g.activeKey)
          .filter((k): k is string => k !== null);
        const evict = pickEviction(after, {
          excludeKeys: [key, ...activeKeys],
          isEvictable: (k) => {
            const e = entriesApi.entriesRef.current[k];
            return !!e && e.file !== null && !isDirtyEntry(e);
          },
        });
        if (evict) after = closeTabInGroup(after, evict.groupId, evict.key);
      }
      const existedBefore = !!entriesApi.entriesRef.current[key];
      applyGroups(after, { activate: groupId });
      entriesApi.ensureEntries([{ kind, path }]);
      if (existedBefore && kind === 'preview') {
        // R-2: 既に開いているプレビューを「プレビューを開く」で再アクティブ化する
        // ときも、タブバーの switchTo と同じく再取得する (保存直後の古い内容を防ぐ)。
        entriesApi.refreshPreviewTab(key, path);
      } else {
        entriesApi.loadFile(key, path);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applyGroups, stashAll],
  );
  const openFile = useCallback((path: string) => openTab('editor', path), [openTab]);
  const openPreview = useCallback((path: string) => openTab('preview', path), [openTab]);

  const switchTab = useCallback(
    (groupId: string, key: string) => {
      stashAll();
      entriesApi.setMessage('');
      applyGroups(activateTab(groupsApi.stateRef.current.root, groupId, key), { activate: groupId });
      const e = entriesApi.entriesRef.current[key];
      if (e?.kind === 'preview') entriesApi.refreshPreviewTab(key, e.path);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applyGroups, stashAll],
  );

  const closeTab = useCallback(
    async (groupId: string, key: string) => {
      const st = groupsApi.stateRef.current;
      const entry = entriesApi.entriesRef.current[key];
      // dirty 確認は「leaf 内の最後の参照を閉じるとき」だけ。他グループに同じ
      // ファイルが残るなら draft は失われない (プールとモデルは共有) ので確認しない。
      if (isDirtyEntry(entry) && groupsWithKey(st.root, key).length === 1) {
        const ok = await confirmDialog({
          title: t('files.discardChangesTitle'),
          message: t('files.discardChangesMessage', { name: basename(entry!.path) }),
          confirmLabel: t('files.discardAndClose'),
          severity: 'danger',
        });
        if (!ok) return;
      }
      const cur = groupsApi.stateRef.current;
      const g = findGroup(cur.root, groupId);
      if (cur.activeGroupId === groupId && g?.activeKey === key) entriesApi.setMessage('');
      applyGroups(closeTabInGroup(cur.root, groupId, key));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applyGroups, confirmDialog, t],
  );

  /** DnD 中のタブが reveal 待ちなら破棄する (移動先で誤ジャンプしないように)。 */
  const cancelPendingRevealFor = (drag: EditorTabDrag) => {
    const p = pendingRevealRef.current;
    if (p && tabKey('editor', p.path) === drag.key) pendingRevealRef.current = null;
  };

  // ---- クロス leaf 転送 (transferRegistry) ----------------------------------

  /** source 側: タブの転送データを読み取る。draft が上限超過の dirty タブは
   *  null (転送拒否) — 削って運ぶと未保存編集が失われるため。 */
  const exportTab = useCallback(
    (key: string): TabTransferPayload | null => {
      const e = entriesApi.entriesRef.current[key];
      if (!e) return null;
      if (e.kind === 'preview') return { kind: 'preview', path: e.path };
      if (e.file === null) {
        // 未ロード: 復元待ち draft をそのまま運ぶ (落とさない — loadFile 前の
        // 復元 draft は draftsRef にしか無い)
        const pending = entriesApi.draftsRef.current[e.path];
        return { kind: 'editor', path: e.path, draft: pending ? { ...pending } : undefined };
      }
      if (e.file.content !== null && isDirtyEntry(e)) {
        if (e.draft.length > MAX_DRAFT_TEXT_LENGTH) return null;
        return {
          kind: 'editor',
          path: e.path,
          draft: { text: e.draft, baseHash: hashText(e.file.content) },
        };
      }
      return { kind: 'editor', path: e.path };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /** source 側: 転送成立後のタブ除去。確認なし (内容は引っ越し済み)。
   *  最後の参照だった場合は applyGroups → disposeKeys が資源を回収する。 */
  const removeTabAfterTransfer = useCallback(
    (groupId: string, key: string) => {
      const p = pendingRevealRef.current;
      if (p && tabKey('editor', p.path) === key) pendingRevealRef.current = null;
      applyGroups(closeTabInGroup(groupsApi.stateRef.current.root, groupId, key));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applyGroups],
  );

  type ImportTarget =
    | { groupId: string; index?: number }
    | { splitOf: string; zone: Exclude<DropZone, 'center'> };

  /** target 側: 転送タブの受け入れ。true を返したときだけ source が除去する。 */
  const importTransferredTab = useCallback(
    (payload: TabTransferPayload, target: ImportTarget): boolean => {
      const sanitized = sanitizeTransferPayload(payload);
      if (!sanitized) return false;
      const key = tabKey(sanitized.kind, sanitized.path);
      const st = groupsApi.stateRef.current;
      // 重複ルール: この leaf に同じ {kind, path} が既に開いていたら転送中止 +
      // 既存タブをアクティブ化 (source は残る)。draft のマージは絶対にしない。
      const holders = groupsWithKey(st.root, key);
      if (holders.length > 0) {
        applyGroups(activateTab(st.root, holders[0], key), { activate: holders[0] });
        return false;
      }
      const ref = { kind: sanitized.kind, path: sanitized.path };
      let after: GroupNode;
      let activateId: string;
      if ('splitOf' in target) {
        const dir = target.zone === 'left' || target.zone === 'right' ? 'row' : 'column';
        const before = target.zone === 'left' || target.zone === 'top';
        const res = splitWithTab(st.root, target.splitOf, dir, before, ref);
        if (res.newGroupId === null) return false;
        after = res.root;
        activateId = res.newGroupId;
      } else {
        if (!findGroup(st.root, target.groupId)) return false;
        after = insertTabInGroup(st.root, target.groupId, ref, target.index);
        activateId = target.groupId;
      }
      stashAll();
      entriesApi.setMessage('');
      // openTab と同じ eviction (プールが上限を超えるなら安全に失えるタブを閉じる)
      if (distinctKeys(after).length > MAX_OPEN_FILES) {
        const activeKeys = allGroups(st.root)
          .map((g) => g.activeKey)
          .filter((k): k is string => k !== null);
        const evict = pickEviction(after, {
          excludeKeys: [key, ...activeKeys],
          isEvictable: (k) => {
            const e = entriesApi.entriesRef.current[k];
            return !!e && e.file !== null && !isDirtyEntry(e);
          },
        });
        if (evict) after = closeTabInGroup(after, evict.groupId, evict.key);
      }
      // draft は pending として先に積む → 既存 loadFile の reconcile 経路が
      // baseHash 照合・disk 変更警告まで面倒を見る (モデルは当 leaf の名前空間で新規)
      if (sanitized.kind === 'editor' && sanitized.draft) {
        entriesApi.draftsRef.current[sanitized.path] = sanitized.draft;
      }
      applyGroups(after, { activate: activateId });
      entriesApi.ensureEntries([ref]);
      entriesApi.loadFile(key, sanitized.path);
      return true;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applyGroups, stashAll],
  );

  /** target 側から source を駆動する共通フロー。 */
  const acceptCrossLeafDrop = useCallback(
    (drag: EditorTabDrag, target: ImportTarget) => {
      const src = getTransferHandle(drag.sourceLeafId);
      if (!src) return;
      const payload = src.exportTab(drag.key);
      if (!payload) return;
      if (importTransferredTab(payload, target)) {
        src.removeTabAfterTransfer(drag.sourceGroupId, drag.key);
      }
    },
    [importTransferredTab],
  );

  // このパネルを転送レジストリへ公開 (leafId がアドレス)。
  useEffect(() => {
    registerTransferHandle(leafId, { exportTab, removeTabAfterTransfer });
    return () => unregisterTransferHandle(leafId);
  }, [leafId, exportTab, removeTabAfterTransfer]);

  /** タブストリップへのドロップ: 同一グループ = 並べ替え、別グループ = 移動。
   *  index はドラッグ元タブ込みの並びに対する挿入位置 (同一グループ内で元位置より
   *  右へ挿すときは 1 詰める)。ドロップしたタブは VS Code 同様アクティブになる。 */
  const dropOnTabStrip = useCallback(
    (dstGroupId: string, index: number, drag: EditorTabDrag) => {
      if (drag.sourceLeafId !== leafIdRef.current) {
        acceptCrossLeafDrop(drag, { groupId: dstGroupId, index });
        return;
      }
      const st = groupsApi.stateRef.current;
      let at = index;
      if (drag.sourceGroupId === dstGroupId) {
        const g = findGroup(st.root, dstGroupId);
        const from = g?.tabs.findIndex((r) => refKey(r) === drag.key) ?? -1;
        if (from === -1) return;
        if (from < at) at -= 1;
        if (from === at) {
          groupsApi.setActiveGroup(dstGroupId);
          return;
        }
      }
      stashAll();
      cancelPendingRevealFor(drag);
      let after = moveTabToGroup(st.root, drag.sourceGroupId, drag.key, dstGroupId, at);
      after = activateTab(after, dstGroupId, drag.key);
      applyGroups(after, { activate: dstGroupId });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applyGroups, stashAll],
  );

  /** 本文 5 ゾーンへのドロップ: 中央 = グループへ移動、上下左右 = その方向へ分割作成。 */
  const dropOnEditorZone = useCallback(
    (dstGroupId: string, zone: DropZone, drag: EditorTabDrag) => {
      if (drag.sourceLeafId !== leafIdRef.current) {
        acceptCrossLeafDrop(
          drag,
          zone === 'center' ? { groupId: dstGroupId } : { splitOf: dstGroupId, zone },
        );
        return;
      }
      const st = groupsApi.stateRef.current;
      const srcGroup = findGroup(st.root, drag.sourceGroupId);
      const ref = srcGroup?.tabs.find((r) => refKey(r) === drag.key);
      if (!srcGroup || !ref) return;
      if (zone === 'center') {
        if (drag.sourceGroupId === dstGroupId) return;
        stashAll();
        cancelPendingRevealFor(drag);
        applyGroups(moveTabToGroup(st.root, drag.sourceGroupId, drag.key, dstGroupId), {
          activate: dstGroupId,
        });
        return;
      }
      // 単独タブの自グループ端ドロップは no-op (分割しても片方が空になり即畳まれるだけ)
      if (drag.sourceGroupId === dstGroupId && srcGroup.tabs.length === 1) return;
      stashAll();
      cancelPendingRevealFor(drag);
      const dir = zone === 'left' || zone === 'right' ? 'row' : 'column';
      const before = zone === 'left' || zone === 'top';
      const { root: after, newGroupId } = splitWithTab(st.root, dstGroupId, dir, before, ref, {
        groupId: drag.sourceGroupId,
      });
      applyGroups(after, { activate: newGroupId ?? undefined });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applyGroups, stashAll],
  );

  /** タブバーの分割ボタン: アクティブタブを右隣の新グループへ複製 (VS Code 流)。 */
  const splitGroup = useCallback(
    (groupId: string) => {
      const st = groupsApi.stateRef.current;
      const g = findGroup(st.root, groupId);
      const key = g?.activeKey;
      if (!g || !key) return;
      const ref = g.tabs.find((r) => refKey(r) === key);
      if (!ref) return;
      stashAll();
      const { root: after, newGroupId } = splitWithTab(st.root, groupId, 'row', false, ref);
      applyGroups(after, { activate: newGroupId ?? undefined });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applyGroups, stashAll],
  );

  // ---- 保存 / リロード (アクティブグループへのルーティング) ------------------

  const saveGroup = useCallback(
    (groupId: string) => {
      const g = findGroup(groupsApi.stateRef.current.root, groupId);
      if (!g?.activeKey) return;
      void entriesApi.save(g.activeKey, paneHandlesRef.current.get(groupId)?.getEditor() ?? null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const activeGroupEditorKey = (): { key: string; editor: MonacoEditor | null } | null => {
    const st = groupsApi.stateRef.current;
    const g = findGroup(st.root, st.activeGroupId);
    if (!g?.activeKey) return null;
    return { key: g.activeKey, editor: paneHandlesRef.current.get(g.id)?.getEditor() ?? null };
  };

  // 「エンコーディング指定で再読み込み」。dirty なら確認してから破棄する。
  const reloadWithEncoding = async (encoding: string) => {
    const target = activeGroupEditorKey();
    if (!target) return;
    const entry = entriesApi.entriesRef.current[target.key];
    if (!entry || entry.kind !== 'editor') return;
    if (entry.file && entry.file.content !== null && entry.draft !== entry.file.content) {
      const ok = await confirmDialog({
        title: t('files.reloadTitle'),
        message: t('files.reloadDiscardMessage', { name: basename(entry.path) }),
        confirmLabel: t('files.discardAndReload'),
        severity: 'danger',
      });
      if (!ok) return;
    }
    await entriesApi.reloadWithEncoding(target.key, target.editor, encoding);
  };

  // ---- ジャンプ / ホットキー registry --------------------------------------

  const openAtLine = (path: string, line: number, column = 1) => {
    pendingRevealRef.current = { path, line, column };
    openFile(path);
    // already open and loaded in the active group → jump immediately (state が
    // 変わらず再レンダーされないケースを拾う。それ以外はペインの effect が消化する)
    paneHandlesRef.current.get(groupsApi.stateRef.current.activeGroupId)?.tryReveal();
  };

  const showSearchPanel = () => {
    setSide('search');
    setSearchFocusSeq((n) => n + 1); // re-focus the input on repeat Ctrl+Shift+F
  };

  const openFileRef = useRef(openFile);
  openFileRef.current = openFile;
  const openAtLineRef = useRef(openAtLine);
  openAtLineRef.current = openAtLine;
  const showSearchPanelRef = useRef(showSearchPanel);
  showSearchPanelRef.current = showSearchPanel;

  // Expose this instance to the window-level search hotkeys (Ctrl+P / Ctrl+Shift+F).
  useEffect(() => {
    const id = instanceRef.current;
    registerFilesTab({
      id,
      root,
      isVisible: () => {
        const el = containerRef.current;
        if (!el) return false;
        return el.checkVisibility?.() ?? el.offsetParent !== null;
      },
      openFile: (path) => openFileRef.current(path),
      openAtLine: (path, line, column) => openAtLineRef.current(path, line, column),
      // Ctrl+P should only surface files with an editor tab open — a preview tab isn't
      // "a file open for editing" in the sense that registry's callers care about.
      // グループ横断で重複排除する。
      getOpenTabPaths: () => {
        const seen = new Set<string>();
        const out: string[] = [];
        for (const g of allGroups(groupsApi.stateRef.current.root)) {
          for (const ref of g.tabs) {
            if (ref.kind === 'editor' && !seen.has(ref.path)) {
              seen.add(ref.path);
              out.push(ref.path);
            }
          }
        }
        return out;
      },
      showSearchPanel: () => showSearchPanelRef.current(),
    });
    return () => unregisterFilesTab(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  // ---- ロード / root 切替 / 永続化 effect 群 --------------------------------

  // Mount-only: fires the load for entries restored from localStorage (`file`
  // starts null for every restored entry). Later opens go through openTab.
  useEffect(() => {
    for (const e of Object.values(entriesApi.entriesRef.current)) {
      if (e.file === null) entriesApi.loadFile(e.key, e.path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Worktree switched — open tabs are root-relative, so start fresh. This
  // effect also fires once at mount; that first run must NOT clear the state
  // the lazy initializers above already restored, so it only registers the
  // flush/dispose cleanup the first time through.
  const rootEffectRanRef = useRef(false);
  useEffect(() => {
    const flushRoot = root;
    const flushLeafId = leafId;

    if (!rootEffectRanRef.current) {
      rootEffectRanRef.current = true;
    } else {
      // root actually changed (defensive — WorktreeView normally remounts
      // this component via `key` on worktree switch, so this branch isn't
      // reached in practice).
      setSide('tree');
      pendingRevealRef.current = null;
      const state = loadLeafEditorState(root, leafId);
      groupsApi.reset(state);
      const refs = state ? distinctRefs(state.groups) : [];
      entriesApi.resetAll({
        refs,
        drafts: state?.drafts ?? {},
        viewStates: state?.viewStates ?? {},
      });
      for (const ref of refs) entriesApi.loadFile(tabKey(ref.kind, ref.path), ref.path);
    }

    // On root change or unmount: persist the state open under the outgoing
    // root/leafId, then drop every model this leaf created. The model namespace
    // is the OUTGOING leafId (captured here — leafIdRef would already hold the
    // new value when this cleanup runs).
    return () => {
      flush(flushRoot, flushLeafId);
      disposeModelsSoon(
        Object.values(entriesApi.entriesRef.current)
          .filter((e) => e.kind === 'editor')
          .map((e) => `${flushLeafId}/${e.path}`),
      );
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, leafId, flush]);

  // Persist whenever the group tree (tab set / order / structure / sizes) or
  // the active group changes. The tree object's identity changes only on ops —
  // never on keystrokes (drafts live in the entries pool) — so typing never
  // triggers a localStorage write here.
  useEffect(() => {
    flush(root, leafId);
  }, [groupsApi.root, groupsApi.activeGroupId, root, leafId, flush]);

  // Debounced draft persistence: deliberately depends on `entries` itself, so
  // it re-runs on every keystroke. Only the cheap clearTimeout/setTimeout pair
  // runs each time — flush() only actually fires once 1s has passed since the
  // last change. root/leafId are read via refs so a reschedule never waits on them.
  useEffect(() => {
    const timer = setTimeout(() => flush(rootRef.current, leafIdRef.current), 1000);

    // Same-effect, same trigger: flush() silently skips oversize drafts, so
    // tell the user right here instead of leaving them to discover it on the
    // next reload. Set/clear only ever touch OUR OVERSIZE_DRAFT_WARNING slot,
    // and `prev` is returned as-is when nothing changes (no re-trigger loop).
    entriesApi.setEntries((prev) => {
      let changed = false;
      const next: typeof prev = {};
      for (const [key, e] of Object.entries(prev)) {
        const oversize = isDirtyEntry(e) && e.draft.length > MAX_DRAFT_TEXT_LENGTH;
        if (oversize && e.warning === '') {
          changed = true;
          next[key] = { ...e, warning: OVERSIZE_DRAFT_WARNING };
        } else if (!oversize && e.warning === OVERSIZE_DRAFT_WARNING) {
          changed = true;
          next[key] = { ...e, warning: '' };
        } else {
          next[key] = e;
        }
      }
      return changed ? next : prev;
    });

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entriesApi.entries, flush]);

  // Flush on tab close / reload, where cleanup functions don't get to run.
  useEffect(() => {
    const onPageHide = () => flush(root, leafId);
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [root, leafId, flush]);

  // ---- ペイン連携 -----------------------------------------------------------

  const registerPane = useCallback((groupId: string, handle: PaneHandle | null) => {
    if (handle) paneHandlesRef.current.set(groupId, handle);
    else paneHandlesRef.current.delete(groupId);
  }, []);

  const onEditorInstance = useCallback((groupId: string, editor: MonacoEditor | null) => {
    setEditorInsts((prev) => ((prev[groupId] ?? null) === editor ? prev : { ...prev, [groupId]: editor }));
  }, []);

  const persistNow = useCallback(() => flush(rootRef.current, leafIdRef.current), [flush]);

  const shared: PaneShared = {
    root,
    leafId,
    entriesRef: entriesApi.entriesRef,
    viewStatesRef: entriesApi.viewStatesRef,
    indentAppliedRef: entriesApi.indentAppliedRef,
    pendingRevealRef,
    groupsStateRef: groupsApi.stateRef,
    modelPath: entriesApi.modelPath,
    registerPane,
    onEditorInstance,
    saveGroup,
    setDraft: entriesApi.setDraft,
    persistNow,
    switchTab,
    closeTab: (groupId, key) => void closeTab(groupId, key),
    openPreview,
    openFile,
    refreshPreview: entriesApi.refreshPreviewTab,
    splitGroup,
    focusGroup: groupsApi.setActiveGroup,
    dropOnTabStrip,
    dropOnEditorZone,
  };

  // ---- 描画 -----------------------------------------------------------------

  const touch = () => touchFilesTab(instanceRef.current);

  const activeGroup = findGroup(groupsApi.root, groupsApi.activeGroupId);
  const activeEntry = activeGroup?.activeKey
    ? (entriesApi.entries[activeGroup.activeKey] ?? null)
    : null;
  const activeEditor = editorInsts[groupsApi.activeGroupId] ?? null;
  const showStatusBar =
    activeEntry !== null &&
    activeEntry.kind === 'editor' &&
    !activeEntry.error &&
    activeEntry.file !== null &&
    !activeEntry.file.binary &&
    !activeEntry.file.tooLarge;

  const fileMenuItems = (path: string): ContextMenuItem[] => [
    {
      label: t('files.historyMenuItem'),
      icon: 'history',
      onClick: () => setHistoryPath(path),
    },
    {
      label: 'blame...',
      icon: 'account',
      onClick: () => setBlamePath(path),
    },
    // Markdown 以外のファイルには出さない(disabled ではなく非表示 — 読み取り専用機能なので
    // 「押せるが意味がない」項目を並べない)。
    ...(isMarkdownPath(path)
      ? [
          {
            label: t('files.openPreview'),
            icon: 'preview',
            onClick: () => openPreview(path),
          },
        ]
      : []),
  ];

  // ツリー列ヘッダー: [ツリー] [検索] (空き) [新規ファイル] [新規フォルダー] [再読み込み]
  const leadHeader = (
    <>
      <button
        className={`side-switch-btn ${side === 'tree' ? 'active' : ''}`}
        title={t('files.explorerTooltip')}
        onClick={() => setSide('tree')}
      >
        <span className="codicon codicon-files" />
      </button>
      <button
        className={`side-switch-btn ${side === 'search' ? 'active' : ''}`}
        title={t('files.searchTooltip')}
        onClick={showSearchPanel}
      >
        <span className="codicon codicon-search" />
      </button>
      {side === 'tree' && (
        <span className="side-switch-actions">
          <button
            className="icon-btn"
            onClick={() => treeCtl.current?.startCreate('file')}
            title={t('files.newFileTooltip')}
          >
            <span className="codicon codicon-new-file" />
          </button>
          <button
            className="icon-btn"
            onClick={() => treeCtl.current?.startCreate('dir')}
            title={t('files.newFolderTooltip')}
          >
            <span className="codicon codicon-new-folder" />
          </button>
          <button
            className="icon-btn"
            onClick={() => treeCtl.current?.reload()}
            title={t('files.reloadTitle')}
          >
            <span className="codicon codicon-refresh" />
          </button>
        </span>
      )}
    </>
  );

  return (
    <div className="files-tab" ref={containerRef} onPointerDownCapture={touch} onFocusCapture={touch}>
      <div className="files-tree-pane">
        <div className="side-switch">{leadHeader}</div>
        <div className="side-view" style={{ display: side === 'tree' ? undefined : 'none' }}>
          <FileTree
            root={root}
            selectedPath={activeEntry?.path ?? null}
            onSelectFile={openFile}
            onFileContextMenu={(e, path) => setFileMenu({ x: e.clientX, y: e.clientY, path })}
            controllerRef={treeCtl}
            hideToolbar
          />
        </div>
        {searchVisitedRef.current && (
          <div className="side-view" style={{ display: side === 'search' ? undefined : 'none' }}>
            <SearchPanel
              root={root}
              visible={side === 'search'}
              focusSeq={searchFocusSeq}
              onJump={openAtLine}
              onClose={() => setSide('tree')}
            />
          </div>
        )}
      </div>
      <div className="files-editor-pane">
        <div className="editor-groups-host">
          <GroupSplitView
            node={groupsApi.root}
            onSizes={(splitId, sizes) =>
              groupsApi.set(setGroupSizes(groupsApi.stateRef.current.root, splitId, sizes))
            }
            renderGroup={(group) => (
              <EditorGroupPane
                key={group.id}
                group={group}
                isActiveGroup={group.id === groupsApi.activeGroupId}
                entries={entriesApi.entries}
                message={entriesApi.message}
                shared={shared}
              />
            )}
          />
        </div>
        {showStatusBar && activeEntry.file !== null && (
          <EditorStatusBar
            editor={activeEditor}
            activePath={activeEntry.path}
            file={activeEntry.file}
            onReloadWithEncoding={(encoding) => void reloadWithEncoding(encoding)}
            onSaveWithEncoding={(encoding, bom) => {
              const target = activeGroupEditorKey();
              if (target) void entriesApi.save(target.key, target.editor, { encoding, bom });
            }}
            onEolOverride={() => {
              // eolOverride は editor-only, path 単位 (モデル共有のため)。
              const target = activeGroupEditorKey();
              const entry = target ? entriesApi.entriesRef.current[target.key] : null;
              if (entry?.kind === 'editor') entriesApi.eolOverrideRef.current.add(entry.path);
            }}
          />
        )}
      </div>
      {fileMenu && (
        <ContextMenu
          x={fileMenu.x}
          y={fileMenu.y}
          items={fileMenuItems(fileMenu.path)}
          onClose={() => setFileMenu(null)}
        />
      )}
      {historyPath && (
        <FileHistoryModal dir={root} path={historyPath} onClose={() => setHistoryPath(null)} />
      )}
      {blamePath && <BlameModal dir={root} path={blamePath} onClose={() => setBlamePath(null)} />}
      {dialog}
    </div>
  );
}
