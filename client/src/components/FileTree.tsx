import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Tree, type NodeRendererProps, type TreeApi } from 'react-arborist';
import { api } from '../api';
import type { TreeEntry, TreeStatusEntry } from '../types';

interface TNode {
  id: string; // path relative to root
  name: string;
  type: 'dir' | 'file';
  children: TNode[] | null; // null = directory not loaded yet
  placeholder?: 'file' | 'dir'; // temporary inline create-input node
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
function fileIcon(name: string): { icon: string; color: string } {
  const lower = name.toLowerCase();
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  if (lower.startsWith('.git')) return { icon: 'source-control', color: '#f05133' };
  if (lower.includes('license')) return { icon: 'law', color: '#9a9aa3' };
  if (lower.endsWith('.lock') || lower === 'package-lock.json' || lower === 'pnpm-lock.yaml')
    return { icon: 'lock', color: '#9a9aa3' };
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return { icon: 'file-code', color: '#4fc1ff' };
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return { icon: 'file-code', color: '#e8d44d' };
    case 'json':
    case 'jsonc':
      return { icon: 'json', color: '#e8d44d' };
    case 'md':
    case 'mdx':
      return { icon: 'markdown', color: '#569cd6' };
    case 'html':
    case 'htm':
      return { icon: 'code', color: '#e44d26' };
    case 'css':
    case 'scss':
    case 'less':
      return { icon: 'symbol-color', color: '#c586c0' };
    case 'yml':
    case 'yaml':
    case 'toml':
    case 'ini':
    case 'conf':
    case 'env':
      return { icon: 'gear', color: '#9a9aa3' };
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
    case 'ico':
    case 'webp':
      return { icon: 'file-media', color: '#ce9178' };
    case 'zip':
    case 'gz':
    case 'tgz':
    case '7z':
    case 'rar':
      return { icon: 'file-zip', color: '#ce9178' };
    case 'pdf':
      return { icon: 'file-pdf', color: '#f48771' };
    case 'csv':
    case 'tsv':
    case 'xlsx':
      return { icon: 'table', color: '#4ec9b0' };
    case 'ps1':
    case 'psm1':
    case 'sh':
    case 'bash':
    case 'bat':
    case 'cmd':
      return { icon: 'terminal', color: '#4ec9b0' };
    default:
      return { icon: 'file', color: '#9a9aa3' };
  }
}

export default function FileTree({
  root,
  selectedPath,
  onSelectFile,
}: {
  root: string;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
}) {
  const [nodes, setNodes] = useState<TNode[] | null>(null);
  const [status, setStatus] = useState<TreeStatusEntry[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [size, setSize] = useState({ width: 260, height: 400 });
  const [activeDir, setActiveDir] = useState(''); // directory new items are created in ('' = root)
  const [creating, setCreating] = useState<{ parentId: string; type: 'file' | 'dir' } | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<TreeApi<TNode> | null>(null);
  const loadingRef = useRef(new Set<string>());
  const handledRef = useRef(false); // guards against double confirm/cancel of an inline input

  const loadStatus = useCallback(() => {
    api
      .treeStatus(root)
      .then(setStatus)
      .catch(() => setStatus([]));
  }, [root]);

  const loadRoot = useCallback(() => {
    loadingRef.current.clear();
    api
      .tree(root)
      .then((entries) => setNodes(toNodes(entries)))
      .catch((e: Error) => setError(e.message));
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
  const startCreate = useCallback(
    async (type: 'file' | 'dir') => {
      const parentId = activeDir;
      if (parentId) {
        const node = nodes ? findNode(nodes, parentId) : null;
        if (node && node.children === null) {
          loadingRef.current.delete(parentId);
          await loadDir(parentId);
        }
      }
      handledRef.current = false;
      setNotice('');
      setCreating({ parentId, type });
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

  const displayNodes = useMemo(() => {
    if (!nodes || !creating) return nodes;
    const ph: TNode = {
      id: CREATING_ID,
      name: '',
      type: creating.type === 'dir' ? 'dir' : 'file',
      children: creating.type === 'dir' ? [] : null,
      placeholder: creating.type,
    };
    return insertPlaceholder(nodes, creating.parentId, ph);
  }, [nodes, creating]);

  function Node({ node, style }: NodeRendererProps<TNode>) {
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
            placeholder={isDirPh ? '新規フォルダー名' : '新規ファイル名'}
            onKeyDown={(e) => {
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

  if (error) return <div className="tree-error">⚠ {error}</div>;

  return (
    <div className="tree-wrap">
      <div className="tree-toolbar">
        {notice && <span className="tree-notice" title={notice}>⚠ {notice}</span>}
        <button className="icon-btn" onClick={() => void startCreate('file')} title="新規ファイル">
          <span className="codicon codicon-new-file" />
        </button>
        <button className="icon-btn" onClick={() => void startCreate('dir')} title="新規フォルダー">
          <span className="codicon codicon-new-folder" />
        </button>
        <button className="icon-btn" onClick={loadRoot} title="再読み込み">
          <span className="codicon codicon-refresh" />
        </button>
      </div>
      <div className="tree-host" ref={hostRef}>
        {displayNodes === null ? (
          <div className="tree-loading">読み込み中...</div>
        ) : (
          <Tree<TNode>
            ref={treeRef}
            data={displayNodes}
            idAccessor={(d) => d.id}
            childrenAccessor={(d) => (d.type === 'dir' ? d.children ?? [] : null)}
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
            {Node}
          </Tree>
        )}
      </div>
    </div>
  );
}
