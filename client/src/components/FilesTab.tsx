import { useCallback, useEffect, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { api } from '../api';
import type { FileContent } from '../types';
import { registerFilesTab, touchFilesTab, unregisterFilesTab } from '../search/registry';
import FileTree from './FileTree';
import SearchPanel from './SearchPanel';

interface OpenTab {
  path: string;
  file: FileContent | null; // null while loading
  draft: string;
  error: string;
}

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

function isDirty(t: OpenTab): boolean {
  return !!t.file && t.file.content !== null && t.draft !== t.file.content;
}

const EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  fontSize: 13,
  minimap: { enabled: true },
  scrollBeyondLastLine: false,
  automaticLayout: true,
  renderWhitespace: 'selection',
};

// Monaco models are keyed by `path` and outlive both the editor and this
// component, so a closed tab's draft would silently resurface on reopen (or in
// another worktree, since paths are root-relative). Disposal is deferred a tick
// so React re-renders first and the editor detaches the model before we drop it.
function disposeModelsSoon(paths: string[]) {
  setTimeout(() => {
    for (const p of paths) monaco.editor.getModel(monaco.Uri.parse(p))?.dispose();
  }, 0);
}

export default function FilesTab({ root }: { root: string }) {
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const saveRef = useRef<() => void>(() => {});
  const loadedRef = useRef(new Set<string>()); // paths whose load is in flight or done
  // Monaco models are global; two FilesTab instances (one per tile) opening
  // the same path would fight over one model and dispose each other's drafts.
  // Namespace every model URI with a per-instance prefix.
  const instanceRef = useRef(crypto.randomUUID().slice(0, 8));
  const modelPath = (path: string) => `${instanceRef.current}/${path}`;

  // Left pane: file tree or the Ctrl+Shift+F search panel. The panel stays
  // mounted after first visit (display:none) so query and results survive
  // switching back to the tree — same idea as TileWorkspace's visitedRef.
  const [side, setSide] = useState<'tree' | 'search'>('tree');
  const [searchFocusSeq, setSearchFocusSeq] = useState(0);
  const searchVisitedRef = useRef(false);
  if (side === 'search') searchVisitedRef.current = true;

  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const pendingRevealRef = useRef<{ path: string; line: number; column: number } | null>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;

  // Worktree switched — open tabs are root-relative, so start fresh.
  useEffect(() => {
    setTabs([]);
    setActivePath(null);
    setMessage('');
    setSide('tree');
    pendingRevealRef.current = null;
    const loaded = loadedRef.current;
    loaded.clear();
    // On root change or unmount, drop every model this tab set created.
    return () => disposeModelsSoon([...loaded].map(modelPath));
  }, [root]);

  const active = tabs.find((t) => t.path === activePath) ?? null;
  const modified = active ? isDirty(active) : false;

  // Open a file: focus it if already open, otherwise add a tab and load it.
  const openFile = useCallback(
    (path: string) => {
      setMessage('');
      setActivePath(path);
      setTabs((prev) =>
        prev.some((t) => t.path === path)
          ? prev
          : [...prev, { path, file: null, draft: '', error: '' }],
      );
      if (loadedRef.current.has(path)) return;
      loadedRef.current.add(path);
      api
        .file(root, path)
        .then((f) =>
          setTabs((prev) =>
            prev.map((t) => (t.path === path ? { ...t, file: f, draft: f.content ?? '' } : t)),
          ),
        )
        .catch((e: Error) => {
          loadedRef.current.delete(path); // allow retry on reopen
          setTabs((prev) => prev.map((t) => (t.path === path ? { ...t, error: e.message } : t)));
        });
    },
    [root],
  );

  // Jump to a search match once the target file is loaded AND the editor has
  // switched to its model. Reads only refs, so it can be called from any
  // timing (onMount, the effect below, openAtLine) without stale closures.
  // Never rewrites model content — the uncontrolled-editor invariant holds.
  const tryReveal = () => {
    const p = pendingRevealRef.current;
    const editor = editorRef.current;
    if (!p || !editor) return;
    if (activePathRef.current !== p.path) return;
    const tab = tabsRef.current.find((t) => t.path === p.path);
    if (!tab?.file || tab.file.content === null) return; // loading / binary / tooLarge
    const model = editor.getModel();
    if (!model || model.uri.toString() !== monaco.Uri.parse(modelPath(p.path)).toString()) return;
    const line = Math.min(p.line, model.getLineCount()); // file may have changed since the search
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: p.column });
    editor.focus();
    pendingRevealRef.current = null;
  };

  const openAtLine = (path: string, line: number, column = 1) => {
    pendingRevealRef.current = { path, line, column };
    openFile(path);
    tryReveal(); // already open and loaded → jump immediately
  };

  // Covers the async paths: file load completing, tab/model switches.
  useEffect(() => {
    tryReveal();
  });

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
      getOpenTabPaths: () => tabsRef.current.map((t) => t.path),
      showSearchPanel: () => showSearchPanelRef.current(),
    });
    return () => unregisterFilesTab(id);
  }, [root]);

  const switchTo = (path: string) => {
    setActivePath(path);
    setMessage('');
  };

  const closeTab = (path: string) => {
    const target = tabs.find((t) => t.path === path);
    if (target && isDirty(target) && !confirm(`${basename(path)} の変更を破棄して閉じますか?`)) return;
    const idx = tabs.findIndex((t) => t.path === path);
    const next = tabs.filter((t) => t.path !== path);
    setTabs(next);
    loadedRef.current.delete(path);
    disposeModelsSoon([modelPath(path)]);
    if (activePath === path) {
      const neighbor = next[idx] ?? next[idx - 1] ?? null; // right neighbor, else left
      setActivePath(neighbor?.path ?? null);
      setMessage('');
    }
  };

  const save = async () => {
    if (!active || !active.file || active.file.content === active.draft) return;
    const { path, draft } = active;
    setSaving(true);
    try {
      await api.saveFile(root, path, draft);
      setTabs((prev) =>
        prev.map((t) =>
          t.path === path && t.file ? { ...t, file: { ...t.file, content: draft } } : t,
        ),
      );
      setMessage('✓ 保存しました');
      setTimeout(() => setMessage(''), 2500);
    } catch (e) {
      setMessage(`⚠ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };
  saveRef.current = () => void save();

  const onMount: OnMount = (editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current());
    editorRef.current = editor;
    tryReveal(); // first mount happens after the initial file load completes
  };

  const onChange = (value: string | undefined) => {
    setTabs((prev) => prev.map((t) => (t.path === activePath ? { ...t, draft: value ?? '' } : t)));
  };

  const touch = () => touchFilesTab(instanceRef.current);

  return (
    <div className="files-tab" ref={containerRef} onPointerDownCapture={touch} onFocusCapture={touch}>
      <div className="files-tree-pane">
        <div className="side-switch">
          <button
            className={`side-switch-btn ${side === 'tree' ? 'active' : ''}`}
            title="エクスプローラー"
            onClick={() => setSide('tree')}
          >
            <span className="codicon codicon-files" />
          </button>
          <button
            className={`side-switch-btn ${side === 'search' ? 'active' : ''}`}
            title="検索 (Ctrl+Shift+F)"
            onClick={showSearchPanel}
          >
            <span className="codicon codicon-search" />
          </button>
        </div>
        <div className="side-view" style={{ display: side === 'tree' ? undefined : 'none' }}>
          <FileTree root={root} selectedPath={activePath} onSelectFile={openFile} />
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
        {tabs.length === 0 ? (
          <div className="placeholder">ファイルを選択してください</div>
        ) : (
          <>
            <div className="editor-tabs">
              {tabs.map((t) => (
                <div
                  key={t.path}
                  className={`editor-tab ${activePath === t.path ? 'active' : ''}`}
                  title={t.path}
                  onClick={() => switchTo(t.path)}
                >
                  <span className="editor-tab-name">{basename(t.path)}</span>
                  <span className="editor-tab-actions">
                    {isDirty(t) && <span className="editor-tab-dirty">●</span>}
                    <button
                      className="editor-tab-close"
                      title="閉じる"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(t.path);
                      }}
                    >
                      <span className="codicon codicon-close" />
                    </button>
                  </span>
                </div>
              ))}
            </div>
            {!active ? null : active.error ? (
              <div className="placeholder">⚠ {active.error}</div>
            ) : !active.file ? (
              <div className="placeholder">読み込み中...</div>
            ) : active.file.binary ? (
              <div className="placeholder">
                バイナリファイルは表示できません ({active.file.size} bytes)
              </div>
            ) : active.file.tooLarge ? (
              <div className="placeholder">
                ファイルが大きすぎます ({Math.round(active.file.size / 1024)} KB)
              </div>
            ) : (
              <>
                <div className="editor-toolbar">
                  <span className="editor-path" title={active.path}>
                    {active.path}
                    {modified && <span className="editor-modified"> ●</span>}
                  </span>
                  <span className="editor-msg">{message}</span>
                  <button
                    className="primary"
                    disabled={!modified || saving}
                    onClick={() => void save()}
                    title="Ctrl+S でも保存できます"
                  >
                    {saving ? '保存中...' : '保存'}
                  </button>
                </div>
                <div className="editor-host">
                  {/* Uncontrolled on purpose: passing `value` makes the library rewrite the
                      whole model whenever a re-render (e.g. the 4s repo poll) races a
                      keystroke, which jumps the cursor and corrupts IME composition.
                      State only mirrors the editor via onChange; models are dropped in
                      closeTab / the root effect so stale drafts never resurface. */}
                  <Editor
                    path={modelPath(active.path)}
                    defaultValue={active.draft}
                    onChange={onChange}
                    onMount={onMount}
                    keepCurrentModel
                    theme="vs-dark"
                    options={EDITOR_OPTIONS}
                  />
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
