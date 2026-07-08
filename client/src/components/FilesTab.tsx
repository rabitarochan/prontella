import { useCallback, useEffect, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { api } from '../api';
import type { FileContent } from '../types';
import FileTree from './FileTree';

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

  // Worktree switched — open tabs are root-relative, so start fresh.
  useEffect(() => {
    setTabs([]);
    setActivePath(null);
    setMessage('');
    const loaded = loadedRef.current;
    loaded.clear();
    // On root change or unmount, drop every model this tab set created.
    return () => disposeModelsSoon([...loaded]);
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
    disposeModelsSoon([path]);
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
  };

  const onChange = (value: string | undefined) => {
    setTabs((prev) => prev.map((t) => (t.path === activePath ? { ...t, draft: value ?? '' } : t)));
  };

  return (
    <div className="files-tab">
      <div className="files-tree-pane">
        <FileTree root={root} selectedPath={activePath} onSelectFile={openFile} />
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
                    path={active.path}
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
