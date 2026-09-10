import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Tree, type NodeRendererProps, type TreeApi } from 'react-arborist';
import { api } from '../api';
import { useT } from '../i18n';
import type { TreeEntry, TreeStatusEntry } from '../types';
import { ancestorDirs } from './files/treeReveal';

interface TNode {
  id: string; // path relative to root
  name: string;
  type: 'dir' | 'file';
  children: TNode[] | null; // null = directory not loaded yet
  placeholder?: 'file' | 'dir'; // temporary inline create-input node
  renaming?: boolean; // row temporarily rendered as an inline rename input
}

const CREATING_ID = '__creating__';

function toNodes(entries: TreeEntry[]): TNode[] {
  return entries.map((e) => ({ id: e.path, name: e.name, type: e.type, children: null }));
}

function withChildren(nodes: TNode[], id: string, children: TNode[]): TNode[] {
  return nodes.map((n) => {
    if (n.id === id) return { ...n, children };
    if (n.children?.length) return { ...n, children: withChildren(n.children, id, children) };
    return n;
  });
}

function findNode(nodes: TNode[], id: string): TNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.children) {
      const found = findNode(n.children, id);
      if (found) return found;
    }
  }
  return null;
}

/** Re-map a freshly fetched level, preserving already-loaded children of surviving dirs. */
function mergeLevel(prev: TNode[] | null, fresh: TNode[]): TNode[] {
  const byId = new Map((prev ?? []).map((n) => [n.id, n] as const));
  return fresh.map((n) => {
    const old = byId.get(n.id);
    return old && old.type === 'dir' && old.children ? { ...n, children: old.children } : n;
  });
}

/** Mark the node at `id` as an inline-rename row (identity-preserving deep map). */
function withRenamingFlag(nodes: TNode[], id: string): TNode[] {
  return nodes.map((n) => {
    if (n.id === id) return { ...n, renaming: true };
    if (n.children?.length) return { ...n, children: withRenamingFlag(n.children, id) };
    return n;
  });
}

function insertPlaceholder(nodes: TNode[], parentId: string, ph: TNode): TNode[] {
  if (parentId === '') return [ph, ...nodes];
  return nodes.map((n) => {
    if (n.id === parentId) return { ...n, children: [ph, ...(n.children ?? [])] };
    if (n.children?.length) return { ...n, children: insertPlaceholder(n.children, parentId, ph) };
    return n;
  });
}

function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/** VS Code-ish file icon (codicon name + color) by file name. */
export function fileIcon(name: string): { icon: string; color: string } {
  const lower = name.toLowerCase();
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  // 色はテーマ変数(index.css でライト/ダーク別に定義)。ブランド色(git/html)のみ両テーマ共通の実色。
  if (lower.startsWith('.git')) return { icon: 'source-control', color: '#f05133' };
  if (lower.includes('license')) return { icon: 'law', color: 'var(--fg-dim)' };
  if (lower.endsWith('.lock') || lower === 'package-lock.json' || lower === 'pnpm-lock.yaml')
    return { icon: 'lock', color: 'var(--fg-dim)' };
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return { icon: 'file-code', color: 'var(--file-icon-ts)' };
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return { icon: 'file-code', color: 'var(--file-icon-js)' };
    case 'json':
    case 'jsonc':
      return { icon: 'json', color: 'var(--file-icon-js)' };
    case 'md':
    case 'mdx':
      return { icon: 'markdown', color: 'var(--blue)' };
    case 'html':
    case 'htm':
      return { icon: 'code', color: '#e44d26' };
    case 'css':
    case 'scss':
    case 'less':
      return { icon: 'symbol-color', color: 'var(--file-icon-css)' };
    case 'yml':
    case 'yaml':
    case 'toml':
    case 'ini':
    case 'conf':
    case 'env':
      return { icon: 'gear', color: 'var(--fg-dim)' };
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
    case 'ico':
    case 'webp':
      return { icon: 'file-media', color: 'var(--orange)' };
    case 'zip':
    case 'gz':
    case 'tgz':
    case '7z':
    case 'rar':
      return { icon: 'file-zip', color: 'var(--orange)' };
    case 'pdf':
      return { icon: 'file-pdf', color: 'var(--red)' };
    case 'csv':
    case 'tsv':
    case 'xlsx':
      return { icon: 'table', color: 'var(--green)' };
    case 'ps1':
    case 'psm1':
    case 'sh':
    case 'bash':
    case 'bat':
    case 'cmd':
      return { icon: 'terminal', color: 'var(--green)' };
    default:
      return { icon: 'file', color: 'var(--fg-dim)' };
  }
}

interface FileTreeCtxValue {
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  onEntryContextMenu?: (e: React.MouseEvent, path: string, kind: 'file' | 'dir') => void;
  loadDir: (id: string) => Promise<void>;
  setActiveDir: (id: string) => void;
  colorClass: (path: string, isDir: boolean) => string;
  confirmCreate: (rawName: string) => Promise<void>;
  cancelCreate: () => void;
  confirmRename: (rawName: string) => Promise<void>;
  cancelRename: () => void;
}

const FileTreeCtx = createContext<FileTreeCtxValue>(null!);

// idAccessor / childrenAccessor も <Tree> の props として TreeProvider の updateCount
// (provider.tsx L57-60: Object.values(treeProps) を依存配列に丸ごと積む) を毎レンダー回すため、
// インライン関数にせずモジュールスコープの定数として identity を固定する。
const idAccessor = (d: TNode) => d.id;
const childrenAccessor = (d: TNode) => (d.type === 'dir' ? (d.children ?? []) : null);

/**
 * react-arborist は <Tree> の children (= 行レンダラー) を props.children として保持し、
 * row-container.tsx L75-79 で `const Node = tree.renderNode; <Node .../>` と要素タイプ
 * そのものとして描画する。そのため FileTree のレンダー関数の内側でこのコンポーネントを
 * 定義すると、再レンダーのたびに identity が変わり React が全行の subtree を
 * unmount/remount してしまう(インライン input の入力値が数秒おきに消える不具合の原因)。
 * 必ずモジュールスコープに置き、FileTree のクロージャーが必要な値は FileTreeCtx 経由で渡すこと。
 */
function TreeNode({ node, style }: NodeRendererProps<TNode>) {
  const t = useT();
  const {
    selectedPath,
    onSelectFile,
    onEntryContextMenu,
    loadDir,
    setActiveDir,
    colorClass,
    confirmCreate,
    cancelCreate,
    confirmRename,
    cancelRename,
  } = useContext(FileTreeCtx);

  if (node.data.renaming) {
    const isDirRn = node.data.type === 'dir';
    const { icon, color } = isDirRn
      ? { icon: node.isOpen ? 'folder-opened' : 'folder', color: '#dcb67a' }
      : fileIcon(node.data.name);
    return (
      <div className="tree-row" style={style}>
        <span
          className={`tree-chevron codicon codicon-chevron-right ${node.isOpen ? 'open' : ''}`}
          style={{ visibility: isDirRn ? 'visible' : 'hidden' }}
        />
        <span className={`tree-icon codicon codicon-${icon}`} style={{ color }} />
        <input
          className="tree-name-input"
          autoFocus
          // autoFocus だけだと、コンテキストメニュー (Radix DropdownMenu) のクローズ時
          // フォーカス処理に負けて input が非フォーカスのまま残る (実機で確認)。
          // マウント直後の次タスクで奪い返す (1 回だけ — 再レンダーで再発火させない)。
          ref={(el) => {
            if (!el || el.dataset.autofocused) return;
            el.dataset.autofocused = '1';
            setTimeout(() => el.focus(), 0);
          }}
          defaultValue={node.data.name}
          // フォーカス時に拡張子を除く stem を選択する (VS Code の F2 と同じ)
          onFocus={(e) => {
            const name = node.data.name;
            const dot = name.lastIndexOf('.');
            e.currentTarget.setSelectionRange(0, dot > 0 ? dot : name.length);
          }}
          onKeyDown={(e) => {
            // 必ず止める: react-arborist のコンテナー onKeyDown にタイプアヘッド検索が
            // あり、伝播すると入力文字に一致する行へ DOM フォーカスが移って input が
            // blur → 中途の名前で確定/キャンセルされてしまう (不具合報告の原因)
            e.stopPropagation();
            if (e.key === 'Enter') void confirmRename(e.currentTarget.value);
            else if (e.key === 'Escape') cancelRename();
          }}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== node.data.name) void confirmRename(v);
            else cancelRename();
          }}
        />
      </div>
    );
  }

  if (node.data.placeholder) {
    const isDirPh = node.data.placeholder === 'dir';
    return (
      <div className="tree-row" style={style}>
        <span
          className="tree-chevron codicon codicon-chevron-right"
          style={{ visibility: isDirPh ? 'visible' : 'hidden' }}
        />
        <span
          className={`tree-icon codicon codicon-${isDirPh ? 'folder' : 'file'}`}
          style={{ color: isDirPh ? '#dcb67a' : '#9a9aa3' }}
        />
        <input
          className="tree-name-input"
          autoFocus
          // コンテキストメニューから起動されたときは Radix のクローズ時フォーカス処理に
          // autoFocus が負けるので、リネーム入力と同じく次タスクで奪い返す
          ref={(el) => {
            if (!el || el.dataset.autofocused) return;
            el.dataset.autofocused = '1';
            setTimeout(() => el.focus(), 0);
          }}
          placeholder={isDirPh ? t('files.newFolderNamePlaceholder') : t('files.newFileNamePlaceholder')}
          onKeyDown={(e) => {
            // 必ず止める: 伝播すると react-arborist のタイプアヘッド検索が一致行へ
            // フォーカスを移し、input が blur → 中途の名前で確定されてしまう
            e.stopPropagation();
            if (e.key === 'Enter') void confirmCreate(e.currentTarget.value);
            else if (e.key === 'Escape') cancelCreate();
          }}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v) void confirmCreate(v);
            else cancelCreate();
          }}
        />
      </div>
    );
  }

  const isDir = node.data.type === 'dir';
  const { icon, color } = isDir
    ? { icon: node.isOpen ? 'folder-opened' : 'folder', color: '#dcb67a' }
    : fileIcon(node.data.name);
  return (
    <div
      className={`tree-row ${!isDir && selectedPath === node.data.id ? 'selected' : ''}`}
      style={style}
      title={node.data.id}
      onClick={() => {
        if (isDir) {
          node.toggle();
          if (node.data.children === null) void loadDir(node.data.id);
          setActiveDir(node.data.id);
        } else {
          onSelectFile(node.data.id);
          setActiveDir(parentOf(node.data.id));
        }
      }}
      onContextMenu={
        onEntryContextMenu
          ? (e) => {
              e.preventDefault();
              onEntryContextMenu(e, node.data.id, node.data.type);
            }
          : undefined
      }
    >
      <span
        className={`tree-chevron codicon codicon-chevron-right ${node.isOpen ? 'open' : ''}`}
        style={{ visibility: isDir ? 'visible' : 'hidden' }}
      />
      <span className={`tree-icon codicon codicon-${icon}`} style={{ color }} />
      <span className={`tree-name ${colorClass(node.data.id, isDir)}`}>{node.data.name}</span>
    </div>
  );
}

/** ツリー操作をヘッダー側 (FilesTab の統合ヘッダー行) から呼ぶためのハンドル。 */
export interface FileTreeHandle {
  /** parentId 省略時は最後にクリックした場所 (activeDir) に作る。 */
  startCreate: (kind: 'file' | 'dir', parentId?: string) => void;
  startRename: (path: string) => void;
  refreshLevel: (parentId: string) => Promise<void>;
  /** 削除後の後片付け: 新規作成先 (activeDir) が消えたパス配下なら親へ退避してから親階層を再取得。 */
  refreshAfterDelete: (path: string) => Promise<void>;
  reload: () => void;
}

export default function FileTree({
  root,
  selectedPath,
  onSelectFile,
  onEntryContextMenu,
  onRenamed,
  controllerRef,
  hideToolbar,
  autoReveal,
}: {
  root: string;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  /**
   * ファイル行 / ディレクトリー行の右クリックで発火する。ContextMenu の構築・表示は
   * 呼び出し元 (FilesTab) の責務 — BranchTree の onContextMenu と同じ分担パターン。
   */
  onEntryContextMenu?: (e: React.MouseEvent, path: string, kind: 'file' | 'dir') => void;
  /** インラインリネームの成立後に発火する (開いているタブのパス追随は呼び出し元の責務)。 */
  onRenamed?: (oldPath: string, newPath: string, kind: 'file' | 'dir') => void;
  /** ツリー操作 (新規作成 / リネーム / 再読み込み) を外部トリガーにするためのハンドル受け口。 */
  controllerRef?: React.MutableRefObject<FileTreeHandle | null>;
  /** 内蔵ツールバーを描画しない (操作は controllerRef 経由。notice 行だけは残る)。 */
  hideToolbar?: boolean;
  /** selectedPath の祖先を自動で読み込み・展開し、その行までスクロールする。 */
  autoReveal?: boolean;
}) {
  const t = useT();
  const [nodes, setNodes] = useState<TNode[] | null>(null);
  const [status, setStatus] = useState<TreeStatusEntry[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [size, setSize] = useState({ width: 260, height: 400 });
  const [activeDir, setActiveDir] = useState(''); // directory new items are created in ('' = root)
  const [creating, setCreating] = useState<{ parentId: string; type: 'file' | 'dir' } | null>(null);
  const [renaming, setRenaming] = useState<{ path: string; kind: 'file' | 'dir' } | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<TreeApi<TNode> | null>(null);
  const loadingRef = useRef(new Set<string>());
  const handledRef = useRef(false); // guards against double confirm/cancel of an inline input
  const nodesRef = useRef(nodes); // revealPath から stale なしに「未読み込みの階層」を判定するため
  nodesRef.current = nodes;
  const genRef = useRef(0); // loadRoot の世代カウンター。古い非同期結果を setNodes/setError から弾く
  const prevRootRef = useRef<string | null>(null); // root が実際に切り替わったかを判定するための直前値

  const loadStatus = useCallback(() => {
    api
      .treeStatus(root)
      .then(setStatus)
      .catch(() => setStatus([]));
  }, [root]);

  const loadRoot = useCallback(() => {
    // root が実際に切り替わったときだけ開閉状態をリセットする。前の root のパスに対する
    // 開閉状態が残ったまま新しい root のパスを再取得すると、無関係な id を開こうとしてしまう。
    // openState を読む前に閉じ切る必要があるため、必ずこの読み出しより先に呼ぶ。
    if (prevRootRef.current !== null && prevRootRef.current !== root) {
      treeRef.current?.closeAll();
    }
    prevRootRef.current = root;

    const myGen = ++genRef.current;
    loadingRef.current.clear();

    // 再読み込み前に開いていた dir の id を集める。openByDefault={false} なのでマップに
    // 無い id (または値が false) は閉じている扱いでよい。
    const openState = treeRef.current?.openState ?? {};
    const openIds = new Set(Object.keys(openState).filter((id) => openState[id]));

    // 開いている dir だけ子階層を再取得し、子が埋まった木を組み立て直す。閉じている dir の
    // children は null のままにする(次に開いたときに loadDir が取り直し、内容も最新化される)。
    const fetchOpenChildren = async (levelNodes: TNode[]): Promise<TNode[]> =>
      Promise.all(
        levelNodes.map(async (n) => {
          if (n.type !== 'dir' || !openIds.has(n.id)) return n;
          try {
            const entries = await api.tree(root, n.id);
            if (myGen !== genRef.current) return n; // 世代が古ければ以降の合成をやめる
            loadingRef.current.add(n.id); // loadDir の二重ロードガードと矛盾させない
            const children = await fetchOpenChildren(toNodes(entries));
            return { ...n, children };
          } catch {
            // 削除された等で取得できなかった dir。children は null のままにしつつ、
            // 開閉状態も閉じ側に落として「開いて見えるのに空」という不具合状態を残さない。
            if (myGen === genRef.current) treeRef.current?.close(n.id);
            return n;
          }
        }),
      );

    api
      .tree(root)
      .then((entries) => fetchOpenChildren(toNodes(entries)))
      .then((rebuilt) => {
        if (myGen === genRef.current) setNodes(rebuilt);
      })
      .catch((e: Error) => {
        if (myGen === genRef.current) setError(e.message);
      });
    loadStatus();
  }, [root, loadStatus]);

  useEffect(loadRoot, [loadRoot]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(() => {
      setSize({ width: host.clientWidth, height: host.clientHeight });
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const loadDir = useCallback(
    async (id: string) => {
      if (loadingRef.current.has(id)) return;
      loadingRef.current.add(id);
      try {
        const entries = await api.tree(root, id);
        setNodes((prev) => (prev ? withChildren(prev, id, toNodes(entries)) : prev));
      } catch {
        loadingRef.current.delete(id);
      }
    },
    [root],
  );

  // ---- 自動リビール (VS Code の explorer.autoReveal 相当) ---------------------
  // ツリーは遅延読み込みなので、閉じているディレクトリー配下のファイルは data に
  // 存在せず、行そのものが描画されない。祖先を並列に取得して 1 回で木へ反映し、
  // 開閉状態を立ててから該当行までスクロールする。
  const revealingRef = useRef<string | null>(null); // 進行中の reveal 対象 (世代ガード)

  /**
   * react-arborist の scrollTo は内部の waitFor がリトライ上限で reject したあとも
   * setTimeout(check, 10) を止めない実装のため、可視行にならない id を渡すと 10ms
   * 周期のタイマーが永久に残る。可視行になったことを自前で有限回だけ待ってから呼ぶ
   * (その時点では waitFor の初回チェックで即 resolve する)。
   */
  const scrollWhenVisible = useCallback((path: string, tries = 0) => {
    const tree = treeRef.current;
    if (!tree || revealingRef.current !== path) return;
    // パネルが display:none / タイル非表示のあいだは行が 1 つも描画されない。
    // 可視化されたときに reveal の effect が仕切り直すので、ここでは降りる。
    if ((hostRef.current?.clientHeight ?? 0) <= 0) return;
    if (path in tree.idToIndex) {
      revealingRef.current = null;
      void tree.scrollTo(path, 'smart')?.catch(() => {});
      return;
    }
    if (tries >= 20) return; // 削除された等 — 黙って諦める
    requestAnimationFrame(() => scrollWhenVisible(path, tries + 1));
  }, []);

  const revealPath = useCallback(
    async (path: string) => {
      const dirs = ancestorDirs(path);
      // 未読み込みの階層だけ取得する (children が null、または親ごと未読み込みで木にいない)。
      const missing = dirs.filter((d) => findNode(nodesRef.current ?? [], d)?.children == null);
      if (missing.length > 0) {
        let fetched: [string, TNode[]][];
        try {
          fetched = await Promise.all(
            missing.map(async (d) => [d, toNodes(await api.tree(root, d))] as [string, TNode[]]),
          );
        } catch {
          return; // 削除された / 権限が無い等 — 何もしない
        }
        if (revealingRef.current !== path) return; // 別のファイルへ切り替わった
        const byId = new Map(fetched);
        setNodes((prev) => {
          if (!prev) return prev;
          // 必ず浅い順に畳み込む: withChildren は親が既に木にいることを前提にする
          let out = prev;
          for (const d of dirs) {
            const children = byId.get(d);
            if (children) out = withChildren(out, d, children);
          }
          return out;
        });
        for (const d of missing) loadingRef.current.add(d); // loadDir の二重ロードガードと揃える
      }
      // data にまだ無い id でも open state は立てられる (react-arborist は redux へ
      // dispatch するだけ)。再描画は最後の 1 回で足りる。
      dirs.forEach((d, i) => treeRef.current?.open(d, i === dirs.length - 1));
      scrollWhenVisible(path);
    },
    [root, scrollWhenVisible],
  );

  const treeReady = nodes !== null;
  const canScroll = size.height > 0;
  useEffect(() => {
    if (!autoReveal || !selectedPath || !treeReady || !canScroll) return;
    revealingRef.current = selectedPath;
    void revealPath(selectedPath);
    // nodes 自体は deps に入れない (revealPath が setNodes するのでループする)。
    // 開閉状態も入れないので、ユーザーが手動で親を畳んだら次にタブが変わるまで
    // 再展開しない (VS Code と同じ挙動)。
  }, [autoReveal, selectedPath, treeReady, canScroll, revealPath]);

  /** Re-fetch one directory level, preserving expanded children, then refresh git status. */
  const refreshLevel = useCallback(
    async (parentId: string) => {
      const entries = await api.tree(root, parentId);
      const fresh = toNodes(entries);
      setNodes((prev) => {
        if (!prev) return parentId === '' ? fresh : prev;
        if (parentId === '') return mergeLevel(prev, fresh);
        const existing = findNode(prev, parentId);
        return withChildren(prev, parentId, mergeLevel(existing?.children ?? null, fresh));
      });
      loadStatus();
    },
    [root, loadStatus],
  );

  // ---- git-status coloring ---------------------------------------------------
  // Fully-untracked / fully-ignored directories arrive as a single "dir" entry;
  // their descendants are matched by prefix. Modified entries are always files.
  const statusIndex = useMemo(() => {
    const newFiles = new Set<string>();
    const newDirs: string[] = [];
    const newDesc: string[] = []; // new files + new-dir prefixes, for folder rollup
    const modFiles = new Set<string>();
    const modList: string[] = [];
    const ignoredFiles = new Set<string>();
    const ignoredDirs: string[] = [];
    for (const e of status) {
      if (e.state === 'ignored') {
        if (e.dir) ignoredDirs.push(e.path);
        else ignoredFiles.add(e.path);
      } else if (e.state === 'new') {
        if (e.dir) newDirs.push(e.path);
        else newFiles.add(e.path);
        newDesc.push(e.path);
      } else {
        modFiles.add(e.path);
        modList.push(e.path);
      }
    }
    return { newFiles, newDirs, newDesc, modFiles, modList, ignoredFiles, ignoredDirs };
  }, [status]);

  const colorClass = useCallback(
    (path: string, isDir: boolean): string => {
      const under = (dirs: string[]) => dirs.some((d) => path === d || path.startsWith(d + '/'));
      if (statusIndex.ignoredFiles.has(path) || under(statusIndex.ignoredDirs)) return 'git-ignored';
      // self or descendant of an untracked directory → entirely new
      if (statusIndex.newFiles.has(path) || under(statusIndex.newDirs)) return 'git-new';
      if (!isDir) return statusIndex.modFiles.has(path) ? 'git-modified' : '';
      // folder rollup: modified wins over new
      const prefix = path + '/';
      if (statusIndex.modList.some((p) => p.startsWith(prefix))) return 'git-modified';
      if (statusIndex.newDesc.some((p) => p.startsWith(prefix))) return 'git-new';
      return '';
    },
    [statusIndex],
  );

  // ---- inline create ---------------------------------------------------------
  /** parentOverride: コンテキストメニューの「ファイル/フォルダーの作成」用。省略時は activeDir。 */
  const startCreate = useCallback(
    async (type: 'file' | 'dir', parentOverride?: string) => {
      const parentId = parentOverride ?? activeDir;
      if (parentId) {
        const node = nodes ? findNode(nodes, parentId) : null;
        if (node && node.children === null) {
          loadingRef.current.delete(parentId);
          await loadDir(parentId);
        }
      }
      handledRef.current = false;
      setNotice('');
      setRenaming(null); // creating と renaming は相互排他 (handledRef を共有するため)
      setCreating({ parentId, type });
      // 明示指定された親は次回以降の作成先にもする (VS Code のフォーカスディレクトリー相当)
      if (parentOverride !== undefined) setActiveDir(parentOverride);
    },
    [activeDir, nodes, loadDir],
  );

  // Make sure the target directory is expanded so the input row is visible.
  useEffect(() => {
    if (creating && creating.parentId) treeRef.current?.open(creating.parentId);
  }, [creating]);

  const cancelCreate = useCallback(() => {
    if (handledRef.current) return;
    handledRef.current = true;
    setCreating(null);
  }, []);

  const confirmCreate = useCallback(
    async (rawName: string) => {
      if (handledRef.current) return;
      const c = creating;
      if (!c) return;
      const name = rawName.trim();
      if (!name) {
        handledRef.current = true;
        setCreating(null);
        return;
      }
      handledRef.current = true;
      const relPath = c.parentId ? `${c.parentId}/${name}` : name;
      setCreating(null);
      try {
        if (c.type === 'file') await api.createFile(root, relPath);
        else await api.createFolder(root, relPath);
        await refreshLevel(c.parentId);
        if (c.type === 'file') onSelectFile(relPath);
      } catch (e) {
        setNotice(e instanceof Error ? e.message : String(e));
      }
    },
    [creating, root, refreshLevel, onSelectFile],
  );

  // ---- inline rename ---------------------------------------------------------
  const startRename = useCallback(
    (path: string) => {
      const node = nodes ? findNode(nodes, path) : null;
      if (!node) return;
      handledRef.current = false;
      setNotice('');
      setCreating(null); // creating と renaming は相互排他 (handledRef を共有するため)
      setRenaming({ path, kind: node.type });
    },
    [nodes],
  );

  const cancelRename = useCallback(() => {
    if (handledRef.current) return;
    handledRef.current = true;
    setRenaming(null);
  }, []);

  const confirmRename = useCallback(
    async (rawName: string) => {
      if (handledRef.current) return;
      const r = renaming;
      if (!r) return;
      const name = rawName.trim();
      const oldName = r.path.slice(r.path.lastIndexOf('/') + 1);
      if (!name || name === oldName) {
        handledRef.current = true;
        setRenaming(null);
        return;
      }
      handledRef.current = true;
      setRenaming(null);
      try {
        const { path: newPath } = await api.renameEntry(root, r.path, name);
        // 新規作成先 (activeDir) がリネームされたパス配下を指していたら追随させる
        setActiveDir((prev) =>
          prev === r.path ? newPath : prev.startsWith(r.path + '/') ? newPath + prev.slice(r.path.length) : prev,
        );
        await refreshLevel(parentOf(r.path));
        onRenamed?.(r.path, newPath, r.kind);
      } catch (e) {
        setNotice(e instanceof Error ? e.message : String(e));
      }
    },
    [renaming, root, refreshLevel, onRenamed],
  );

  const displayNodes = useMemo(() => {
    if (!nodes) return nodes;
    let out = nodes;
    if (renaming) out = withRenamingFlag(out, renaming.path);
    if (creating) {
      const ph: TNode = {
        id: CREATING_ID,
        name: '',
        type: creating.type === 'dir' ? 'dir' : 'file',
        children: creating.type === 'dir' ? [] : null,
        placeholder: creating.type,
      };
      out = insertPlaceholder(out, creating.parentId, ph);
    }
    return out;
  }, [nodes, creating, renaming]);

  const ctx = useMemo<FileTreeCtxValue>(
    () => ({
      selectedPath,
      onSelectFile,
      onEntryContextMenu,
      loadDir,
      setActiveDir,
      colorClass,
      confirmCreate,
      cancelCreate,
      confirmRename,
      cancelRename,
    }),
    [selectedPath, onSelectFile, onEntryContextMenu, loadDir, setActiveDir, colorClass, confirmCreate, cancelCreate, confirmRename, cancelRename],
  );

  // 統合ヘッダー行 (FilesTab) から操作できるよう毎レンダーで最新のクロージャーを公開する
  if (controllerRef) {
    controllerRef.current = {
      startCreate: (kind, parentId) => void startCreate(kind, parentId),
      startRename,
      refreshLevel,
      refreshAfterDelete: (path) => {
        setActiveDir((prev) => (prev === path || prev.startsWith(path + '/') ? parentOf(path) : prev));
        return refreshLevel(parentOf(path));
      },
      reload: loadRoot,
    };
  }

  if (error) return <div className="tree-error">⚠ {error}</div>;

  return (
    <div className="tree-wrap">
      {hideToolbar ? (
        notice && (
          <div className="tree-toolbar">
            <span className="tree-notice" title={notice}>⚠ {notice}</span>
          </div>
        )
      ) : (
        <div className="tree-toolbar">
          {notice && <span className="tree-notice" title={notice}>⚠ {notice}</span>}
          <button className="icon-btn" onClick={() => void startCreate('file')} title={t('files.newFileTooltip')}>
            <span className="codicon codicon-new-file" />
          </button>
          <button className="icon-btn" onClick={() => void startCreate('dir')} title={t('files.newFolderTooltip')}>
            <span className="codicon codicon-new-folder" />
          </button>
          <button className="icon-btn" onClick={loadRoot} title={t('files.reloadTitle')}>
            <span className="codicon codicon-refresh" />
          </button>
        </div>
      )}
      <div className="tree-host" ref={hostRef}>
        {displayNodes === null ? (
          <div className="tree-loading">{t('common.loading')}</div>
        ) : (
          <FileTreeCtx.Provider value={ctx}>
            <Tree<TNode>
              ref={treeRef}
              data={displayNodes}
              idAccessor={idAccessor}
              childrenAccessor={childrenAccessor}
              width={size.width}
              height={size.height}
              rowHeight={24}
              indent={12}
              openByDefault={false}
              disableDrag
              disableDrop
              disableEdit
              disableMultiSelection
            >
              {TreeNode}
            </Tree>
          </FileTreeCtx.Provider>
        )}
      </div>
    </div>
  );
}
