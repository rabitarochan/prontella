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
import { Group, Separator } from 'react-resizable-panels';
import { api } from '../api';
import { copyText } from '../clipboard';
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
import { basename, toPosixPath } from './editorTabs';
import FileHistoryModal from './FileHistoryModal';
import FileTree, { type FileTreeHandle } from './FileTree';
import SearchPanel from './SearchPanel';
import SplitPanel from './SplitPanel';
import { useAutoReveal } from '../layout/autoRevealStore';
import { PANE_DEFAULT_PCT, paneSplitSizes } from '../layout/paneWidths';
import { usePaneWidths } from '../layout/paneWidthStore';
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
  pathIsWithin,
  pickEviction,
  removeTabPaths,
  renamedPath,
  renameTabPaths,
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
import { useGitGutter } from './files/useGitGutter';

// sanitizeEditorState (editorState.ts) silently drops any draft over
// MAX_DRAFT_TEXT_LENGTH on restore, so a draft that big is invisible to the
// user unless flagged explicitly here. Holds the StringKey (not the resolved
// text) so translate() can resolve it at render time — this constant also
// doubles as the sentinel value compared against below, so the field itself
// stays a StringKey end to end.
const OVERSIZE_DRAFT_WARNING: StringKey = 'files.oversizeDraftWarning';

// ウィンドウ復帰時のディスク突き合わせの最小間隔。focus と visibilitychange が
// 続けて発火したときに 2 度走らせないためだけのもの (ポーリング間隔ではない)。
const DISK_SYNC_MIN_INTERVAL_MS = 300;

export default function FilesTab({
  root,
  leafId,
  visible,
}: {
  root: string;
  leafId: string;
  /** このタイルが現在ファイルビューを表示中か (TileWorkspace の display 切替)。
   *  タブバーは常にグループ内インラインなので描画には使わないが、ディスク突き合わせの
   *  対象判定 (非表示タイルでは走らせない / 表示になった瞬間に走らせる) に使う。 */
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
  // ガター差分 (VS Code の dirty diff 相当)。entries には触らず、Monaco モデルの生死を
  // 直接購読して装飾だけを載せる (詳細は useGitGutter のコメント)。
  const gitGutter = useGitGutter(root, leafId);

  const containerRef = useRef<HTMLDivElement>(null);
  // ツリー列の幅 (全タイル共通のグローバル設定)。SplitPanel が defaultSize を凍結するので、
  // ここで読んだ値が効くのはマウント時のみ — 別タイルでの変更は remount まで反映されない
  // (タイル分割 / エディター分割と同じ契約。理由は SplitPanel.tsx)。
  const treeWidth = usePaneWidths((s) => s.widths.filesTree);
  const setPaneWidth = usePaneWidths((s) => s.setWidth);
  // 自動リビール (全タイル共通のグローバル設定)。幅と違い凍結しないので即座に反映される。
  const autoReveal = useAutoReveal((s) => s.on);
  const setAutoReveal = useAutoReveal((s) => s.setOn);
  const [treeSize, editorSize] = paneSplitSizes(treeWidth, PANE_DEFAULT_PCT.filesTree);
  // パネル id は DOM の id 属性になる。複数タイルで衝突しないよう leafId を前置する。
  const treePanelId = `${leafId}:files-tree`;
  const editorPanelId = `${leafId}:files-editor`;
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

  // ファイルツリーの右クリックメニュー。リネーム/複製は上書きしない操作(既存パスへの
  // 上書きはサーバーが拒否)なので ConfirmDialog は不要 — pj-git-route の原則どおり。
  const [fileMenu, setFileMenu] = useState<{ x: number; y: number; path: string; kind: 'file' | 'dir' } | null>(null);
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

  // ---- ディスク突き合わせ (外部変更の取り込み) ------------------------------
  //
  // 監視もポーリングもしない。ウィンドウ / ファイルビュー / タブがアクティブになった
  // ときだけ、そのとき見えているタブをディスクと突き合わせる。判定は diskSync.ts。

  /** 1 グループのアクティブタブを突き合わせる。preview は従来どおり無条件で再取得。 */
  const syncGroupActiveTab = useCallback((groupId: string, key: string) => {
    const e = entriesApi.entriesRef.current[key];
    if (!e) return;
    if (e.kind === 'preview') {
      entriesApi.refreshPreviewTab(key, e.path);
      return;
    }
    void entriesApi.syncFromDisk(key, paneHandlesRef.current.get(groupId)?.getEditor() ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 全グループのアクティブタブ。非アクティブタブはそのタブに切り替えた瞬間に拾う。 */
  const syncAllActiveTabs = useCallback(() => {
    for (const g of allGroups(groupsApi.stateRef.current.root)) {
      if (g.activeKey) syncGroupActiveTab(g.id, g.activeKey);
    }
    // ガター差分の比較基準 (index の内容) も同じきっかけで取り直す。ターミナルや
    // 外部のエディターで git を操作した場合は gitEpoch が bump されないため、
    // ウィンドウ復帰がその取りこぼしを拾う唯一の経路になる。
    gitGutter.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncGroupActiveTab]);

  const syncAllActiveTabsRef = useRef(syncAllActiveTabs);
  syncAllActiveTabsRef.current = syncAllActiveTabs;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const lastSyncAtRef = useRef(0);

  // focus と visibilitychange の両方を張る: alt-tab によるウィンドウ復帰では
  // visibilitychange が発火しないブラウザーがあり、逆にブラウザーのタブ切替では
  // focus が来ないことがある。両方来たときは短い間隔で 2 度走らないよう間引く。
  useEffect(() => {
    const onActivate = () => {
      if (document.visibilityState !== 'visible') return;
      if (visibleRef.current === false) return; // このタイルはファイルビューを表示していない
      const now = performance.now();
      if (now - lastSyncAtRef.current < DISK_SYNC_MIN_INTERVAL_MS) return;
      lastSyncAtRef.current = now;
      syncAllActiveTabsRef.current();
    };
    window.addEventListener('focus', onActivate);
    document.addEventListener('visibilitychange', onActivate);
    return () => {
      window.removeEventListener('focus', onActivate);
      document.removeEventListener('visibilitychange', onActivate);
    };
  }, []);

  // タイルの表示が他ビュー → ファイルビューへ切り替わったときも同じ突き合わせを行う。
  const prevVisibleRef = useRef(visible);
  useEffect(() => {
    const was = prevVisibleRef.current;
    prevVisibleRef.current = visible;
    if (visible && !was) {
      lastSyncAtRef.current = performance.now();
      syncAllActiveTabs();
    }
  }, [visible, syncAllActiveTabs]);

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
      // ロード済みのエントリーが既にある場合だけ「再アクティブ化」扱いにする。
      // file === null (ロード中 / ロード失敗) は loadFile に任せる — 失敗したタブを
      // 開き直したときの再試行経路がここで消えないようにするため。
      const loadedBefore = (entriesApi.entriesRef.current[key]?.file ?? null) !== null;
      applyGroups(after, { activate: groupId });
      entriesApi.ensureEntries([{ kind, path }]);
      if (loadedBefore) {
        // 既に開いているタブの再アクティブ化。プレビューは無条件に再取得し (R-2:
        // 保存直後の古い内容を防ぐ)、エディターはディスクと突き合わせる。
        // loadFile は loadedRef ガードで no-op になるためここでは呼ばない。
        syncGroupActiveTab(groupId, key);
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
      // プレビューは再取得、エディターはディスクと突き合わせる。非アクティブだった
      // タブの外部変更はここで拾われる (フォーカス時はアクティブタブしか見ないため)。
      syncGroupActiveTab(groupId, key);
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

  // ---- ツリーのリネーム追随 --------------------------------------------------
  // インラインリネーム成立後、この leaf 内で開いているタブ (ディレクトリーなら配下全て) を
  // 新パスへ移す。dirty な draft は draftsRef (復元待ちキュー) 経由で運ぶ — リネームは
  // ディスク内容を変えないので loadFile の baseHash 照合が成立し、dirty のまま復元される。
  // 別 leaf (別タイル) の同ファイルタブは追随しない (外部ツールによるリネームと同じ扱いで、
  // 既存のロードエラー表示にフォールバックする)。
  const onTreeRenamed = useCallback(
    (oldPath: string, newPath: string) => {
      stashAll();
      const before = groupsApi.stateRef.current.root;
      const affected = distinctRefs(before).filter((r) => renamedPath(r.path, oldPath, newPath) !== null);
      if (affected.length === 0) return;
      for (const ref of affected) {
        if (ref.kind !== 'editor') continue;
        const from = ref.path;
        const to = renamedPath(from, oldPath, newPath)!;
        const e = entriesApi.entriesRef.current[tabKey('editor', from)];
        if (e && isDirtyEntry(e) && e.file?.content != null) {
          entriesApi.draftsRef.current[to] = { text: e.draft, baseHash: hashText(e.file.content) };
        } else if (entriesApi.draftsRef.current[from]) {
          // 未ロードのまま残っていた復元待ち draft もそのまま新パスへ運ぶ
          entriesApi.draftsRef.current[to] = entriesApi.draftsRef.current[from];
        }
        for (const states of Object.values(entriesApi.viewStatesRef.current)) {
          if (from in states) states[to] = states[from];
        }
        if (entriesApi.eolOverrideRef.current.has(from)) entriesApi.eolOverrideRef.current.add(to);
      }
      // 旧キーは orphan になり applyGroups → disposeKeys が旧モデル・旧 draft を回収する
      // (移送済みなので安全)。
      applyGroups(renameTabPaths(before, oldPath, newPath));
      const newRefs = affected.map((r) => ({ kind: r.kind, path: renamedPath(r.path, oldPath, newPath)! }));
      entriesApi.ensureEntries(newRefs);
      for (const r of newRefs) entriesApi.loadFile(tabKey(r.kind, r.path), r.path);
      const p = pendingRevealRef.current;
      if (p) {
        const np = renamedPath(p.path, oldPath, newPath);
        if (np !== null) pendingRevealRef.current = { ...p, path: np };
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applyGroups, stashAll],
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
    applyDiskVersion: entriesApi.applyDiskVersion,
    dismissDiskChange: entriesApi.dismissDiskChange,
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

  /** setMessage を一定時間で消す (save の成功メッセージと同じ寿命)。 */
  const flashMessage = (text: string) => {
    entriesApi.setMessage(text);
    setTimeout(() => entriesApi.setMessage(''), 2500);
  };

  const copyToClipboard = (text: string) => {
    void copyText(text).then((ok) => {
      if (ok) flashMessage(t('files.copiedMessage'));
    });
  };

  /** ツリー相対パスの親ディレクトリー ('' = root)。 */
  const parentDirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

  const duplicateEntry = (path: string, kind: 'file' | 'dir') => {
    const parent = parentDirOf(path);
    api
      .duplicateEntry(rootRef.current, path)
      .then(async ({ path: newPath }) => {
        await treeCtl.current?.refreshLevel(parent);
        // 作成後にエディターで開く (confirmCreate が新規ファイルを開く既存パターンに合わせる)
        if (kind === 'file') openFile(newPath);
      })
      .catch((e: unknown) => flashMessage(`⚠ ${e instanceof Error ? e.message : String(e)}`));
  };

  const deleteEntry = async (path: string, kind: 'file' | 'dir') => {
    const name = basename(path);
    const ok = await confirmDialog({
      title: t('files.deleteConfirmTitle'),
      message:
        kind === 'dir'
          ? t('files.deleteFolderConfirmMessage', { name })
          : t('files.deleteFileConfirmMessage', { name }),
      confirmLabel: t('files.deleteConfirmLabel'),
      severity: 'danger',
    });
    if (!ok) return;
    try {
      await api.deleteEntry(rootRef.current, path);
    } catch (e) {
      flashMessage(`⚠ ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    // 開いているタブ (ディレクトリーなら配下全て) を閉じる。dirty の追加確認はしない —
    // 削除の確認自体が破棄の同意。orphan 化した draft/モデルは applyGroups → disposeKeys が回収。
    stashAll();
    applyGroups(removeTabPaths(groupsApi.stateRef.current.root, path));
    const p = pendingRevealRef.current;
    if (p && pathIsWithin(p.path, path)) pendingRevealRef.current = null;
    await treeCtl.current?.refreshAfterDelete(path);
  };

  const fileMenuItems = (path: string, kind: 'file' | 'dir'): ContextMenuItem[] => [
    // 作成先: ディレクトリー行ならその中、ファイル行なら同じディレクトリー (VS Code 同様)
    {
      label: t('files.createFileMenuItem'),
      icon: 'new-file',
      onClick: () => treeCtl.current?.startCreate('file', kind === 'dir' ? path : parentDirOf(path)),
    },
    {
      label: t('files.createFolderMenuItem'),
      icon: 'new-folder',
      onClick: () => treeCtl.current?.startCreate('dir', kind === 'dir' ? path : parentDirOf(path)),
    },
    { separator: true },
    {
      label: t('files.revealInExplorerMenuItem'),
      icon: 'folder-opened',
      onClick: () => {
        api.revealInExplorer(rootRef.current, path).catch((e: unknown) => {
          flashMessage(`⚠ ${e instanceof Error ? e.message : String(e)}`);
        });
      },
    },
    { separator: true },
    {
      label: t('files.copyPathMenuItem'),
      icon: 'copy',
      onClick: () => copyToClipboard(toPosixPath(rootRef.current, path)),
    },
    {
      label: t('files.copyRelativePathMenuItem'),
      icon: 'copy',
      onClick: () => copyToClipboard(path),
    },
    { separator: true },
    {
      label: t('files.renameMenuItem'),
      icon: 'edit',
      onClick: () => treeCtl.current?.startRename(path),
    },
    {
      label: kind === 'dir' ? t('files.duplicateFolderMenuItem') : t('files.duplicateFileMenuItem'),
      icon: 'files',
      onClick: () => duplicateEntry(path, kind),
    },
    {
      label: t('files.deleteMenuItem'),
      icon: 'trash',
      danger: true,
      onClick: () => void deleteEntry(path, kind),
    },
    // git 履歴系とプレビューはファイルのみ (ディレクトリーには意味がないので非表示)。
    ...(kind === 'file'
      ? ([
          { separator: true },
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
        ] satisfies ContextMenuItem[])
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
            className={`icon-btn ${autoReveal ? 'active' : ''}`}
            onClick={() => setAutoReveal(!autoReveal)}
            title={t(autoReveal ? 'files.autoRevealOnTooltip' : 'files.autoRevealOffTooltip')}
            aria-pressed={autoReveal}
          >
            <span className="codicon codicon-target" />
          </button>
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
      {/* ツリー列 ⇔ エディターのリサイズ。Group はパネル / セパレーター以外の子を
          置く場所ではないので、コンテキストメニューやモーダルは .files-tab 直下に残す */}
      <Group
        orientation="horizontal"
        className="files-split"
        onLayoutChanged={(layout, meta) => {
          if (!meta.isUserInteraction) return;
          const pct = layout[treePanelId];
          if (pct !== undefined) setPaneWidth('filesTree', pct);
        }}
      >
        <SplitPanel id={treePanelId} initialSize={treeSize} className="files-tree-pane">
          <div className="side-switch">{leadHeader}</div>
          <div className="side-view" style={{ display: side === 'tree' ? undefined : 'none' }}>
            <FileTree
              root={root}
              selectedPath={activeEntry?.path ?? null}
              onSelectFile={openFile}
              onEntryContextMenu={(e, path, kind) => setFileMenu({ x: e.clientX, y: e.clientY, path, kind })}
              onRenamed={onTreeRenamed}
              controllerRef={treeCtl}
              hideToolbar
              autoReveal={autoReveal}
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
        </SplitPanel>
        <Separator className="pane-separator pane-separator-h pane-separator-inset" />
        <SplitPanel id={editorPanelId} initialSize={editorSize} className="files-editor-pane">
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
        </SplitPanel>
      </Group>
      {fileMenu && (
        <ContextMenu
          x={fileMenu.x}
          y={fileMenu.y}
          items={fileMenuItems(fileMenu.path, fileMenu.kind)}
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
