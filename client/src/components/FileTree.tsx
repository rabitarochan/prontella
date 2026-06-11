import { useCallback, useEffect, useRef, useState } from 'react';
import { Tree, type NodeRendererProps } from 'react-arborist';
import { api } from '../api';
import type { TreeEntry } from '../types';

interface TNode {
  id: string; // path relative to root
  name: string;
  type: 'dir' | 'file';
  children: TNode[] | null; // null = directory not loaded yet
}

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
  const [error, setError] = useState('');
  const [size, setSize] = useState({ width: 260, height: 400 });
  const hostRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(new Set<string>());

  const loadRoot = useCallback(() => {
    loadingRef.current.clear();
    api
      .tree(root)
      .then((entries) => setNodes(toNodes(entries)))
      .catch((e: Error) => setError(e.message));
  }, [root]);

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

  function Node({ node, style }: NodeRendererProps<TNode>) {
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
          } else {
            onSelectFile(node.data.id);
          }
        }}
      >
        <span className={`tree-chevron codicon codicon-chevron-right ${node.isOpen ? 'open' : ''}`}
          style={{ visibility: isDir ? 'visible' : 'hidden' }}
        />
        <span className={`tree-icon codicon codicon-${icon}`} style={{ color }} />
        <span className={isDir ? 'tree-dir' : 'tree-file'}>{node.data.name}</span>
      </div>
    );
  }

  if (error) return <div className="tree-error">⚠ {error}</div>;

  return (
    <div className="tree-wrap">
      <div className="tree-toolbar">
        <button className="icon-btn" onClick={loadRoot} title="再読み込み">
          <span className="codicon codicon-refresh" />
        </button>
      </div>
      <div className="tree-host" ref={hostRef}>
        {nodes === null ? (
          <div className="tree-loading">読み込み中...</div>
        ) : (
          <Tree<TNode>
            data={nodes}
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
