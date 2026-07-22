import { useCallback, useEffect, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { api } from '../api';
import type { EditorConfigSettings, FileContent } from '../types';
import {
  hashText,
  loadLeafEditorState,
  MAX_DRAFT_TEXT_LENGTH,
  saveLeafEditorState,
  type LeafEditorState,
} from '../editorState';
import { registerFilesTab, touchFilesTab, unregisterFilesTab } from '../search/registry';
import BlameModal from './BlameModal';
import ContextMenu, { type ContextMenuItem } from './ContextMenu';
import EditorStatusBar from './EditorStatusBar';
import FileHistoryModal from './FileHistoryModal';
import FileTree from './FileTree';
import SearchPanel from './SearchPanel';

interface OpenTab {
  path: string;
  file: FileContent | null; // null while loading
  draft: string;
  error: string;
  /** Set when a restored draft was applied over disk content that changed while the tab was away. */
  warning: string;
}

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

function isDirty(t: OpenTab): boolean {
  return !!t.file && t.file.content !== null && t.draft !== t.file.content;
}

// sanitizeEditorState (editorState.ts) silently drops any draft over
// MAX_DRAFT_TEXT_LENGTH on restore, so a draft that big is invisible to the
// user unless flagged explicitly here.
const OVERSIZE_DRAFT_WARNING = '未保存の編集が大きすぎるため、切替・リロード後は保持されません';

const EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  fontSize: 13,
  minimap: { enabled: true },
  scrollBeyondLastLine: false,
  automaticLayout: true,
  renderWhitespace: 'selection',
  // インデントは applyModelOptions がモデル単位で制御する(editorconfig 指定が
  // なければ手動で detectIndentation を呼ぶ)ので、attach 時の自動検出は切る。
  detectIndentation: false,
};

// editorconfig の charset → 保存時のエンコーディング指定。latin1 は iconv-lite 側の
// ホワイトリストに合わせて上位互換の windows-1252 に寄せる。utf-16 系は BOM 付きで書く。
function charsetToEncoding(charset: EditorConfigSettings['charset']): {
  encoding: string;
  bom: boolean;
} {
  switch (charset) {
    case 'utf-8-bom':
      return { encoding: 'utf-8', bom: true };
    case 'utf-16le':
      return { encoding: 'utf-16le', bom: true };
    case 'utf-16be':
      return { encoding: 'utf-16be', bom: true };
    case 'latin1':
      return { encoding: 'windows-1252', bom: false };
    default:
      return { encoding: 'utf-8', bom: false };
  }
}

// .editorconfig の保存時整形。モデルに適用してから保存することで、エディタ表示と
// 保存内容が常に一致し、Ctrl+Z で整形前に戻せる。トリムと最終行改行は 1 回の
// pushEditOperations にまとめる(複数回に分けると undo の復元位置がずれる)。
function formatOnSave(
  model: monaco.editor.ITextModel,
  ec: EditorConfigSettings | null,
  beforeCursorState: monaco.Selection[] | null,
): void {
  if (!ec) return;
  const edits: monaco.editor.IIdentifiedSingleEditOperation[] = [];
  if (ec.trimTrailingWhitespace) {
    for (let line = 1; line <= model.getLineCount(); line++) {
      const text = model.getLineContent(line);
      const m = /[ \t]+$/.exec(text);
      if (m) edits.push({ range: new monaco.Range(line, m.index + 1, line, text.length + 1), text: '' });
    }
  }
  if (ec.insertFinalNewline) {
    const lastLine = model.getLineCount();
    const text = model.getLineContent(lastLine);
    // トリム適用後に最終行が空になるなら挿入不要。空ファイルにも挿入しない(editorconfig 仕様)。
    // 挿入位置は行末(トリム範囲の後端)なのでトリムの削除範囲とは重ならない。
    const trimmed = ec.trimTrailingWhitespace ? text.replace(/[ \t]+$/, '') : text;
    if (trimmed.length > 0) {
      edits.push({
        range: new monaco.Range(lastLine, text.length + 1, lastLine, text.length + 1),
        text: model.getEOL(),
      });
    }
  }
  model.pushStackElement();
  if (edits.length > 0) model.pushEditOperations(beforeCursorState, edits, () => null);
  if (ec.endOfLine) {
    const want = ec.endOfLine === 'crlf' ? '\r\n' : '\n';
    if (model.getEOL() !== want) {
      model.pushEOL(
        ec.endOfLine === 'crlf'
          ? monaco.editor.EndOfLineSequence.CRLF
          : monaco.editor.EndOfLineSequence.LF,
      );
    }
  }
  model.pushStackElement();
}

// Monaco models are keyed by `path` and outlive both the editor and this
// component, so a closed tab's draft would silently resurface on reopen (or in
// another worktree, since paths are root-relative). Disposal is deferred a tick
// so React re-renders first and the editor detaches the model before we drop it.
function disposeModelsSoon(paths: string[]) {
  setTimeout(() => {
    for (const p of paths) monaco.editor.getModel(monaco.Uri.parse(p))?.dispose();
  }, 0);
}

export default function FilesTab({ root, leafId }: { root: string; leafId: string }) {
  // Restored exactly once at mount (lazy initializer — NOT re-evaluated on
  // re-render). Root changes after mount are handled explicitly by the root
  // effect below, which re-reads storage itself, so this value is never
  // consulted again after the first render.
  const [initialState] = useState<LeafEditorState | null>(() => loadLeafEditorState(root, leafId));
  const [tabs, setTabs] = useState<OpenTab[]>(() =>
    (initialState?.openFiles ?? []).map((path) => ({
      path,
      file: null,
      draft: '',
      error: '',
      warning: '',
    })),
  );
  const [activePath, setActivePath] = useState<string | null>(() => initialState?.activeFile ?? null);
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

  // ファイルツリーの右クリックメニュー(6.3: 「ファイルの履歴...」)。読み取り専用機能なので
  // ConfirmDialog は不要 — pj-git-route の「操作系でない機能は確認不要」の原則どおり。
  const [fileMenu, setFileMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [historyPath, setHistoryPath] = useState<string | null>(null);
  const [blamePath, setBlamePath] = useState<string | null>(null);
  const fileMenuItems = (path: string): ContextMenuItem[] => [
    {
      label: 'ファイルの履歴...',
      icon: 'history',
      onClick: () => setHistoryPath(path),
    },
    {
      label: 'blame...',
      icon: 'account',
      onClick: () => setBlamePath(path),
    },
  ];

  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  // ステータスバー用。ref と違い state にすることで、マウント後に子コンポーネントの
  // 購読 effect が再実行される。バイナリタブ表示中などは Editor ごと破棄されるので
  // onDidDispose で null に戻し、破棄済みインスタンスを子へ渡さない。
  const [editorInst, setEditorInst] = useState<Parameters<OnMount>[0] | null>(null);
  const pendingRevealRef = useRef<{ path: string; line: number; column: number } | null>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;
  // The Monaco onMount callback fires once per editor instance and its
  // closure keeps whatever `root`/`leafId` were current at that moment —
  // read these through refs wherever a long-lived Monaco callback needs the
  // CURRENT value (debounced cursor/scroll flush below).
  const rootRef = useRef(root);
  rootRef.current = root;
  const leafIdRef = useRef(leafId);
  leafIdRef.current = leafId;

  // インデント設定を適用済みのモデル(のタブパス)。モデルは閉じると破棄されるので、
  // closeTab / root 切替で該当エントリも消して再適用させる。
  const indentAppliedRef = useRef(new Set<string>());

  // viewState (カーソル位置・スクロール位置) は stashActiveViewState /
  // tryRestoreViewState でライブ管理する。
  const viewStatesRef = useRef<Record<string, unknown>>(initialState?.viewStates ?? {});
  // draftsRef holds only RESTORED drafts that loadFile hasn't reconciled yet
  // (see loadFile below) — once a tab finishes loading, its entry here is
  // deleted and flush() computes what to persist straight from the live tab
  // state instead. So this ref is a "pending restore" queue, not the
  // authoritative draft store.
  const draftsRef = useRef<Record<string, { text: string; baseHash: string }>>(
    initialState?.drafts ?? {},
  );

  // Snapshot the active tab's cursor/scroll position into viewStatesRef
  // before the editor moves away from it. The URI-match guard is required:
  // without it, a stash racing a model swap could overwrite the WRONG tab's
  // entry with the just-departed model's state.
  const stashActiveViewState = () => {
    const editor = editorRef.current;
    const path = activePathRef.current;
    if (!editor || !path) return;
    const model = editor.getModel();
    if (!model || model.uri.toString() !== monaco.Uri.parse(modelPath(path)).toString()) return;
    const vs = editor.saveViewState();
    if (vs) viewStatesRef.current[path] = vs;
  };

  // Write the current tab set to localStorage under (flushRoot, flushLeafId).
  // Root/leafId are passed as arguments (not read from the closure) so callers
  // — the root-change/unmount cleanup in particular — always target the
  // worktree the flushed state actually belongs to.
  //
  // drafts are computed fresh from the live tabs on every flush (not read
  // back out of draftsRef, which only ever holds RESTORED entries not yet
  // reconciled by loadFile — see loadFile below):
  //   - loaded, editable (non-binary/tooLarge), dirty tabs → the live draft
  //     text + a hash of the disk content it was based on (baseHash), so a
  //     later restore can tell whether the file changed underneath it.
  //     Skipped when the draft is over MAX_DRAFT_TEXT_LENGTH: sanitizeEditorState
  //     (editorState.ts) would silently drop it on restore anyway, so writing
  //     it here would just be dead weight in localStorage. Symmetric with the
  //     read side by construction — both reference the same constant.
  //   - still-loading tabs (file === null) → whatever restored draft
  //     draftsRef still has pending for that path, carried through as-is so
  //     leaving before the load completes doesn't drop it.
  //   - loaded binary/tooLarge/clean tabs → omitted entirely.
  const flush = useCallback((flushRoot: string, flushLeafId: string) => {
    stashActiveViewState(); // capture the latest cursor/scroll before writing
    const drafts: Record<string, { text: string; baseHash: string }> = {};
    for (const t of tabsRef.current) {
      if (t.file === null) {
        const pending = draftsRef.current[t.path];
        if (pending) drafts[t.path] = pending;
      } else if (t.file.content !== null && isDirty(t) && t.draft.length <= MAX_DRAFT_TEXT_LENGTH) {
        drafts[t.path] = { text: t.draft, baseHash: hashText(t.file.content) };
      }
    }
    saveLeafEditorState(flushRoot, flushLeafId, {
      openFiles: tabsRef.current.map((t) => t.path),
      activeFile: activePathRef.current,
      viewStates: viewStatesRef.current,
      drafts,
    });
  }, []);

  // Load a file's content into its tab. Shared by openFile (user-initiated)
  // and the mount / root-change restore paths (tabs whose `file` starts null).
  const loadFile = useCallback(
    (path: string) => {
      if (loadedRef.current.has(path)) return;
      loadedRef.current.add(path);
      api
        .file(root, path)
        .then((f) => {
          // Reconcile a restored (persisted) draft against the just-loaded
          // disk content. Resolved either way below, so drop it from the
          // pending bucket now — flush()'s live computation takes over from
          // here for this path.
          const pending = draftsRef.current[path];
          delete draftsRef.current[path];

          setTabs((prev) =>
            prev.map((t) => {
              if (t.path !== path) return t;
              if (!pending || f.content === null) {
                // No persisted draft to reconcile, or the file can't be
                // edited here (binary/too large) — normal load.
                return { ...t, file: f, draft: f.content ?? '' };
              }
              if (f.content === pending.text) {
                // Disk already matches the draft — nothing to restore.
                return { ...t, file: f, draft: f.content };
              }
              if (hashText(f.content) === pending.baseHash) {
                // Disk is unchanged from the content the draft was based on
                // — safe to reapply.
                return { ...t, file: f, draft: pending.text };
              }
              // Disk changed underneath the draft while the tab was away.
              // Apply the draft anyway (never silently discard it) but warn,
              // since saving now would overwrite the newer disk content.
              return {
                ...t,
                file: f,
                draft: pending.text,
                warning: '切替中にディスク上のファイルが変更されました。保存すると上書きします',
              };
            }),
          );
        })
        .catch((e: Error) => {
          loadedRef.current.delete(path); // allow retry on reopen
          setTabs((prev) => prev.map((t) => (t.path === path ? { ...t, error: e.message } : t)));
        });
    },
    [root],
  );

  // Open a file: focus it if already open, otherwise add a tab and load it.
  const openFile = useCallback(
    (path: string) => {
      stashActiveViewState(); // leaving the current tab (if any) for a different one
      setMessage('');
      setActivePath(path);
      setTabs((prev) =>
        prev.some((t) => t.path === path)
          ? prev
          : [...prev, { path, file: null, draft: '', error: '', warning: '' }],
      );
      loadFile(path);
    },
    [loadFile],
  );

  // Mount-only: fires the load for tabs restored from localStorage (`file`
  // starts null for every restored tab). Later opens go through openFile,
  // which calls loadFile itself.
  useEffect(() => {
    for (const t of tabs) {
      if (t.file === null) loadFile(t.path);
    }
  }, []);

  // Worktree switched — open tabs are root-relative, so start fresh. This
  // effect also fires once at mount (React runs every effect on first
  // commit); that first run must NOT clear the tabs the lazy initializers
  // above already restored, so it only registers the flush/dispose cleanup
  // the first time through.
  const rootEffectRanRef = useRef(false);
  useEffect(() => {
    const flushRoot = root;
    const flushLeafId = leafId;
    const loaded = loadedRef.current;

    if (!rootEffectRanRef.current) {
      rootEffectRanRef.current = true;
    } else {
      // root actually changed (defensive — WorktreeView normally remounts
      // this component via `key` on worktree switch, so this branch isn't
      // reached in practice).
      setTabs([]);
      setActivePath(null);
      setMessage('');
      setSide('tree');
      pendingRevealRef.current = null;
      indentAppliedRef.current.clear();
      loaded.clear();

      const state = loadLeafEditorState(root, leafId);
      viewStatesRef.current = state?.viewStates ?? {};
      draftsRef.current = state?.drafts ?? {};
      const restoredTabs = (state?.openFiles ?? []).map((path) => ({
        path,
        file: null,
        draft: '',
        error: '',
        warning: '',
      }));
      setTabs(restoredTabs);
      setActivePath(state?.activeFile ?? null);
      for (const t of restoredTabs) loadFile(t.path);
    }

    // On root change or unmount: persist the tabs open under the outgoing
    // root/leafId, then drop every model this tab set created.
    return () => {
      flush(flushRoot, flushLeafId);
      disposeModelsSoon([...loaded].map(modelPath));
    };
  }, [root, leafId, flush, loadFile]);

  // Persist open tabs + active tab whenever the tab SET or the active tab
  // changes. Keyed on the path list (not `tabs` itself, whose `draft` field
  // changes on every keystroke) so typing never triggers a localStorage write.
  const tabPathsKey = tabs.map((t) => t.path).join('\n');
  useEffect(() => {
    flush(root, leafId);
  }, [tabPathsKey, activePath, root, leafId, flush]);

  // Debounced draft persistence: unlike tabPathsKey above, this effect
  // deliberately depends on `tabs` itself, so it re-runs on every keystroke
  // (the `draft` field changes each time onChange fires). Only the cheap
  // clearTimeout/setTimeout pair runs on every keystroke — flush() (and the
  // localStorage write inside it) only actually fires once 1s has passed
  // since the last `tabs` change. root/leafId are read via rootRef/leafIdRef
  // rather than added to the deps array, so a reschedule never needs to wait
  // on them specifically.
  useEffect(() => {
    const timer = setTimeout(() => flush(rootRef.current, leafIdRef.current), 1000);

    // Same-effect, same trigger: flush() above silently skips oversize drafts
    // (see flush()'s comment), so tell the user right here instead of leaving
    // them to discover it on the next reload. Set/clear only ever touch OUR
    // OVERSIZE_DRAFT_WARNING slot: setting requires warning to currently be
    // empty (never steals the slot from an unrelated, e.g. restore-conflict,
    // warning), and clearing requires it to currently BE our own text (never
    // clears someone else's warning). `prev` is returned as-is when no tab
    // actually needs a change, so this doesn't itself retrigger the effect
    // (tabs stays referentially the same → the [tabs, flush] deps see no change).
    setTabs((prev) => {
      let changed = false;
      const next = prev.map((t) => {
        const oversize = isDirty(t) && t.draft.length > MAX_DRAFT_TEXT_LENGTH;
        if (oversize && t.warning === '') {
          changed = true;
          return { ...t, warning: OVERSIZE_DRAFT_WARNING };
        }
        if (!oversize && t.warning === OVERSIZE_DRAFT_WARNING) {
          changed = true;
          return { ...t, warning: '' };
        }
        return t;
      });
      return changed ? next : prev;
    });

    return () => clearTimeout(timer);
  }, [tabs, flush]);

  // Flush on tab close / reload, where cleanup functions don't get to run.
  useEffect(() => {
    const onPageHide = () => flush(root, leafId);
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [root, leafId, flush]);

  const active = tabs.find((t) => t.path === activePath) ?? null;
  const modified = active ? isDirty(active) : false;

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

  // editorconfig のインデント設定をアクティブなモデルへ 1 回だけ適用する。
  // tryReveal と同じく ref のみを読むので、onMount / onDidChangeModel /
  // 毎レンダー effect のどこから呼んでも stale にならない。
  const applyModelOptions = () => {
    const editor = editorRef.current;
    const path = activePathRef.current;
    if (!editor || !path || indentAppliedRef.current.has(path)) return;
    const tab = tabsRef.current.find((t) => t.path === path);
    if (!tab?.file || tab.file.content === null) return;
    const model = editor.getModel();
    if (!model || model.uri.toString() !== monaco.Uri.parse(modelPath(path)).toString()) return;
    indentAppliedRef.current.add(path);
    const ec = tab.file.editorconfig;
    // 明示されていない項目は自動検出結果を残したいので、まず検出してから上書きする
    model.detectIndentation(true, 4);
    const opts: monaco.editor.ITextModelUpdateOptions = {};
    if (ec?.indentStyle) opts.insertSpaces = ec.indentStyle === 'space';
    const size = ec?.indentSize ?? ec?.tabWidth;
    if (size) {
      opts.indentSize = size;
      opts.tabSize = ec?.tabWidth ?? size;
    }
    if (Object.keys(opts).length > 0) model.updateOptions(opts);
    // 新規(空)ファイルは end_of_line をデフォルト EOL にする(空なので dirty にならない)
    if (ec?.endOfLine && model.getValueLength() === 0) {
      model.setEOL(
        ec.endOfLine === 'crlf'
          ? monaco.editor.EndOfLineSequence.CRLF
          : monaco.editor.EndOfLineSequence.LF,
      );
    }
  };

  // Re-apply the cursor/scroll position stashed for the active tab whenever
  // its model becomes current again. Ref-only and timing-agnostic like
  // tryReveal, so it's safe from onMount / onDidChangeModel. NOT consume-once
  // — switching back to a tab always re-restores its last stashed position.
  // pendingReveal (an explicit search jump) takes priority when both target
  // the same tab; tryReveal runs after this and overwrites the cursor itself.
  const tryRestoreViewState = () => {
    const editor = editorRef.current;
    const path = activePathRef.current;
    if (!editor || !path) return;
    const vs = viewStatesRef.current[path];
    if (vs === undefined) return;
    const model = editor.getModel();
    if (!model || model.uri.toString() !== monaco.Uri.parse(modelPath(path)).toString()) return;
    if (pendingRevealRef.current?.path === path) return; // explicit navigation wins
    try {
      editor.restoreViewState(vs as monaco.editor.ICodeEditorViewState);
    } catch {
      delete viewStatesRef.current[path]; // corrupt/incompatible persisted value — drop it
    }
  };

  // Covers the async paths: file load completing, tab/model switches.
  useEffect(() => {
    applyModelOptions();
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
    stashActiveViewState(); // leaving the current tab for `path`
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
    indentAppliedRef.current.delete(path);
    delete viewStatesRef.current[path];
    delete draftsRef.current[path];
    disposeModelsSoon([modelPath(path)]);
    if (activePath === path) {
      const neighbor = next[idx] ?? next[idx - 1] ?? null; // right neighbor, else left
      setActivePath(neighbor?.path ?? null);
      setMessage('');
    }
  };

  // encOverride は「指定エンコーディングで保存」用。非 dirty でも encOverride 付き
  // なら保存する(エンコーディング変換だけの保存を許す)。ref 経由で読むので
  // ステータスバーのハンドラーからも stale なく呼べる。
  const save = async (encOverride?: { encoding: string; bom: boolean }) => {
    const path = activePathRef.current;
    const tab = path ? tabsRef.current.find((t) => t.path === path) : null;
    if (!path || !tab?.file || tab.file.content === null) return;
    if (tab.draft === tab.file.content && !encOverride) return;
    const ec = tab.file.editorconfig;
    // 新規(空)ファイルに限り editorconfig の charset を保存エンコーディングの
    // デフォルトにする(既存ファイルを勝手に文字コード変換しない)
    const isEmptyFile = tab.file.content === '' && tab.file.size === 0;
    const enc =
      encOverride ??
      (isEmptyFile && ec?.charset
        ? charsetToEncoding(ec.charset)
        : { encoding: tab.file.encoding ?? 'utf-8', bom: tab.file.hasBom });
    setSaving(true);
    try {
      // 保存時整形をモデルに適用してから getValue() を送る。アクティブなモデルが
      // 取れない特殊ケースでは整形をスキップして draft をそのまま送る(安全側)。
      const model = editorRef.current?.getModel();
      let content = tab.draft;
      if (model && model.uri.toString() === monaco.Uri.parse(modelPath(path)).toString()) {
        formatOnSave(model, ec, editorRef.current?.getSelections() ?? null);
        content = model.getValue();
      }
      await api.saveFile(root, path, content, enc);
      setTabs((prev) =>
        prev.map((t) =>
          t.path === path && t.file
            ? {
                ...t,
                draft: content,
                file: { ...t.file, content, encoding: enc.encoding, hasBom: enc.bom },
                warning: '', // a successful save resolves any restore-time conflict
              }
            : t,
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

  // 「エンコーディング指定で再読み込み」。dirty なら確認してから破棄する。
  const reloadWithEncoding = async (encoding: string) => {
    const path = activePathRef.current;
    const tab = path ? tabsRef.current.find((t) => t.path === path) : null;
    if (!path || !tab) return;
    if (tab.file && tab.file.content !== null && tab.draft !== tab.file.content) {
      if (!confirm(`${basename(path)} の未保存の変更を破棄して再読み込みしますか?`)) return;
    }
    try {
      const f = await api.file(root, path, encoding);
      setTabs((prev) =>
        prev.map((t) =>
          t.path === path
            ? { ...t, file: f, draft: f.content ?? '', error: '', warning: '' } // draft is discarded here, so any restore-time conflict no longer applies
            : t,
        ),
      );
      // uncontrolled モデルなので明示的に反映する(tryReveal と同じ URI 一致ガード付き。
      // undo 履歴はリセットされるがリロードなので許容)。インデントも内容が変わったので
      // 再検出させる。
      const model = editorRef.current?.getModel();
      if (
        f.content !== null &&
        model &&
        model.uri.toString() === monaco.Uri.parse(modelPath(path)).toString()
      ) {
        model.setValue(f.content);
        indentAppliedRef.current.delete(path);
        applyModelOptions();
      }
      setMessage('');
    } catch (e) {
      setMessage(`⚠ ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const onMount: OnMount = (editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current());
    editorRef.current = editor;
    editor.onDidChangeModel(() => {
      // タブ切替(モデル切替)を捕まえる。indent 適用 → 保存済みカーソル/スクロール
      // 復元 → (あれば)検索ジャンプの順: 検索ジャンプは復元されたカーソル位置を
      // 上書きして常に優先される。
      applyModelOptions();
      tryRestoreViewState();
      tryReveal();
    });
    setEditorInst(editor);
    applyModelOptions();
    tryRestoreViewState();
    tryReveal(); // first mount happens after the initial file load completes

    // Persist cursor/scroll position without waiting for a tab switch, so a
    // reload right after moving the cursor doesn't lose it. Debounced so
    // rapid cursor/scroll events don't hammer localStorage. These events also
    // fire on model swaps, but stashActiveViewState's URI-match guard makes
    // that a no-op — it only ever writes the CURRENTLY active model's state.
    // root/leafId are read through rootRef/leafIdRef (not this closure's own
    // parameters): onMount fires once per editor instance and must stay
    // correct even if the props were to change later without a remount.
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleFlush = () => {
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        flush(rootRef.current, leafIdRef.current);
      }, 500);
    };
    const cursorSub = editor.onDidChangeCursorPosition(scheduleFlush);
    const scrollSub = editor.onDidScrollChange(scheduleFlush);

    editor.onDidDispose(() => {
      setEditorInst((cur) => (cur === editor ? null : cur));
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
      cursorSub.dispose();
      scrollSub.dispose();
    });
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
          <FileTree
            root={root}
            selectedPath={activePath}
            onSelectFile={openFile}
            onFileContextMenu={(e, path) => setFileMenu({ x: e.clientX, y: e.clientY, path })}
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
                {active.warning && <div className="editor-warning">⚠ {active.warning}</div>}
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
                <EditorStatusBar
                  editor={editorInst}
                  activePath={active.path}
                  file={active.file}
                  onReloadWithEncoding={(encoding) => void reloadWithEncoding(encoding)}
                  onSaveWithEncoding={(encoding, bom) => void save({ encoding, bom })}
                />
              </>
            )}
          </>
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
    </div>
  );
}
