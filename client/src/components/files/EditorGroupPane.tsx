// 1 エディターグループ = タブバー + 本文 (Monaco / Markdown プレビュー /
// プレースホルダー)。FilesTab.tsx のエディター描画部を移設し、グループ単位に
// スコープしたもの。Monaco の viewState は (groupId, path) 単位で
// stash/restore する — 同一ファイルを 2 グループで開いてもスクロール位置は独立。
// モデル自体は leaf 内で共有 (URI は `${leafId}/${path}` のまま) なので、
// 編集内容は全グループへ即時反映される。
//
// グループ分割の作成/消滅の瞬間、既存グループの <Editor> は再マウントされ得る
// (ジオメトリ層に portal は使わない設計判断)。モデルは keepCurrentModel で生き残り、
// カーソル/スクロールは stash 済み viewState から復元される。

import { useEffect, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import type { MutableRefObject } from 'react';
import { tabKey } from '../../editorState';
import { useT } from '../../i18n';
import { zoneFromPoint, type DropZone } from '../../layout/dropZones';
import { useEditorTabDnd, type EditorTabDrag } from '../../layout/editorTabDnd';
import { monacoThemeName } from '../../theme/monacoTheme';
import { useTheme } from '../../theme/themeStore';
import MarkdownPreview from '../MarkdownPreview';
import type { EditorGroup, GroupNode } from './editorGroups';
import EditorTabsBar from './EditorTabsBar';
import { EDITOR_OPTIONS } from './monacoSave';
import type { FileEntry, MonacoEditor } from './useFileEntries';

/** ディスク突き合わせのオーバーレイを出すまでの猶予 (これ以下で終われば見せない)。 */
const RELOAD_OVERLAY_DELAY_MS = 150;

/** `on` が delayMs 以上続いたときだけ true を返す (短い処理でのチラつき防止)。 */
function useDelayedFlag(on: boolean, delayMs: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!on) {
      setShown(false);
      return;
    }
    const id = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(id);
  }, [on, delayMs]);
  return shown;
}

/** コーディネーター (FilesTab) がグループ横断操作に使うペインのハンドル。 */
export interface PaneHandle {
  getEditor: () => MonacoEditor | null;
  /** このグループのアクティブタブの viewState を viewStatesRef へ退避する。 */
  stash: () => void;
  /** pendingReveal の即時消化を試みる (openAtLine の「既にロード済み」経路)。 */
  tryReveal: () => void;
}

/**
 * ペインがコーディネーターと共有する参照・コールバックの束。関数は全て
 * 「最新状態を ref 経由で読む」実装であること — ペインは Monaco の長寿命
 * コールバックからこれらを呼ぶため、stale closure を持ち込めない。
 */
export interface PaneShared {
  root: string;
  leafId: string;
  entriesRef: MutableRefObject<Record<string, FileEntry>>;
  viewStatesRef: MutableRefObject<Record<string, Record<string, unknown>>>;
  indentAppliedRef: MutableRefObject<Set<string>>;
  pendingRevealRef: MutableRefObject<{ path: string; line: number; column: number } | null>;
  groupsStateRef: MutableRefObject<{ root: GroupNode; activeGroupId: string }>;
  modelPath: (path: string) => string;
  registerPane: (groupId: string, handle: PaneHandle | null) => void;
  /** ステータスバー配線用。エディター生成/破棄で呼ばれる。 */
  onEditorInstance: (groupId: string, editor: MonacoEditor | null) => void;
  saveGroup: (groupId: string) => void;
  setDraft: (key: string, value: string) => void;
  /** カーソル/スクロール移動の 500ms デバウンス後に呼ばれる永続化。 */
  persistNow: () => void;
  switchTab: (groupId: string, key: string) => void;
  closeTab: (groupId: string, key: string) => void;
  openPreview: (path: string) => void;
  openFile: (path: string) => void;
  refreshPreview: (key: string, path: string) => void;
  /** 外部変更バナーの「破棄して最新を読み込む」。 */
  applyDiskVersion: (key: string, editor: MonacoEditor | null) => void;
  /** 外部変更バナーの「編集を継続」。 */
  dismissDiskChange: (key: string) => void;
  splitGroup: (groupId: string) => void;
  focusGroup: (groupId: string) => void;
  /** タブ DnD の解決 (同一 leaf: 並べ替え/移動/分割。別 leaf: 転送)。 */
  dropOnTabStrip: (dstGroupId: string, index: number, drag: EditorTabDrag) => void;
  dropOnEditorZone: (dstGroupId: string, zone: DropZone, drag: EditorTabDrag) => void;
}

export default function EditorGroupPane({
  group,
  isActiveGroup,
  entries,
  message,
  shared,
}: {
  group: EditorGroup;
  isActiveGroup: boolean;
  entries: Record<string, FileEntry>;
  message: string;
  shared: PaneShared;
}) {
  const t = useT();
  // theme prop が古い値のまま Editor が再マウントされるとグローバルテーマを
  // 巻き戻してしまうため、常に現在の解決済みテーマを渡す
  const resolvedTheme = useTheme((s) => s.resolved);

  const editorRef = useRef<MonacoEditor | null>(null);
  const sharedRef = useRef(shared);
  sharedRef.current = shared;
  const groupRef = useRef(group);
  groupRef.current = group;

  // R-3: プレビュー本文のスクロール位置 (path → scrollTop)。グループローカル
  // (同一 path のプレビューを 2 グループで開いてもスクロールが独立)。メモリのみ。
  const previewScrollPositionsRef = useRef(new Map<string, number>());

  // Snapshot this group's active tab's cursor/scroll into viewStatesRef before
  // the editor moves away from it. The URI-match guard is required: without it,
  // a stash racing a model swap could overwrite the WRONG tab's entry with the
  // just-departed model's state.
  const stash = () => {
    const editor = editorRef.current;
    const g = groupRef.current;
    const key = g.activeKey;
    if (!editor || !key) return;
    const s = sharedRef.current;
    const entry = s.entriesRef.current[key];
    if (!entry || entry.kind !== 'editor') return; // viewStates are editor-only
    const model = editor.getModel();
    if (!model || model.uri.toString() !== monaco.Uri.parse(s.modelPath(entry.path)).toString())
      return;
    const vs = editor.saveViewState();
    if (vs) {
      const states = (s.viewStatesRef.current[g.id] ??= {});
      states[entry.path] = vs;
    }
  };

  // Re-apply the cursor/scroll position stashed for the group's active tab
  // whenever its model becomes current again. Ref-only and timing-agnostic, so
  // it's safe from onMount / onDidChangeModel. NOT consume-once — switching
  // back to a tab always re-restores its last stashed position. pendingReveal
  // (an explicit search jump, active group only) takes priority; tryReveal runs
  // after this and overwrites the cursor itself.
  const tryRestoreViewState = () => {
    const editor = editorRef.current;
    const g = groupRef.current;
    const key = g.activeKey;
    if (!editor || !key) return;
    const s = sharedRef.current;
    const entry = s.entriesRef.current[key];
    if (!entry || entry.kind !== 'editor') return;
    const path = entry.path;
    const vs = s.viewStatesRef.current[g.id]?.[path];
    if (vs === undefined) return;
    const model = editor.getModel();
    if (!model || model.uri.toString() !== monaco.Uri.parse(s.modelPath(path)).toString()) return;
    if (s.pendingRevealRef.current?.path === path && s.groupsStateRef.current.activeGroupId === g.id)
      return; // explicit navigation wins
    try {
      editor.restoreViewState(vs as monaco.editor.ICodeEditorViewState);
    } catch {
      delete s.viewStatesRef.current[g.id]?.[path]; // corrupt/incompatible persisted value — drop it
    }
  };

  // editorconfig のインデント設定をアクティブなモデルへ 1 回だけ適用する。
  // indentAppliedRef は path 単位 (モデル共有のため) — 別グループが適用済みなら
  // このグループでは何もしない。ref のみを読むのでどのタイミングでも stale にならない。
  const applyModelOptions = () => {
    const editor = editorRef.current;
    const g = groupRef.current;
    const key = g.activeKey;
    if (!editor || !key) return;
    const s = sharedRef.current;
    const entry = s.entriesRef.current[key];
    if (!entry || entry.kind !== 'editor' || s.indentAppliedRef.current.has(entry.path)) return;
    if (!entry.file || entry.file.content === null) return;
    const path = entry.path;
    const model = editor.getModel();
    if (!model || model.uri.toString() !== monaco.Uri.parse(s.modelPath(path)).toString()) return;
    s.indentAppliedRef.current.add(path);
    const ec = entry.file.editorconfig;
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

  // Jump to a search match once the target file is loaded AND this group's
  // editor has switched to its model. Reveal は「アクティブグループ」だけが
  // 消化する — 非アクティブグループが同じファイルを表示していても奪わない。
  // Never rewrites model content — the uncontrolled-editor invariant holds.
  const tryReveal = () => {
    const s = sharedRef.current;
    const p = s.pendingRevealRef.current;
    const editor = editorRef.current;
    const g = groupRef.current;
    if (!p || !editor) return;
    if (s.groupsStateRef.current.activeGroupId !== g.id) return;
    const key = tabKey('editor', p.path);
    if (g.activeKey !== key) return;
    const entry = s.entriesRef.current[key];
    if (!entry?.file || entry.file.content === null) return; // loading / binary / tooLarge
    const model = editor.getModel();
    if (!model || model.uri.toString() !== monaco.Uri.parse(s.modelPath(p.path)).toString()) return;
    const line = Math.min(p.line, model.getLineCount()); // file may have changed since the search
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: p.column });
    editor.focus();
    s.pendingRevealRef.current = null;
  };

  // コーディネーターへの登録。ハンドルの各関数は ref のみを読むため、
  // 初回レンダーのクロージャーのままで常に最新状態に対して動く。
  useEffect(() => {
    const id = group.id;
    sharedRef.current.registerPane(id, { getEditor: () => editorRef.current, stash, tryReveal });
    return () => {
      sharedRef.current.registerPane(id, null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group.id]);

  // Covers the async paths: file load completing, tab/model switches.
  useEffect(() => {
    applyModelOptions();
    tryReveal();
  });

  const onMount: OnMount = (editor, monacoNS) => {
    editor.addCommand(monacoNS.KeyMod.CtrlCmd | monacoNS.KeyCode.KeyS, () =>
      sharedRef.current.saveGroup(groupRef.current.id),
    );
    editorRef.current = editor;
    editor.onDidChangeModel(() => {
      // タブ切替(モデル切替)を捕まえる。indent 適用 → 保存済みカーソル/スクロール
      // 復元 → (あれば)検索ジャンプの順: 検索ジャンプは復元されたカーソル位置を
      // 上書きして常に優先される。
      applyModelOptions();
      tryRestoreViewState();
      tryReveal();
    });
    sharedRef.current.onEditorInstance(groupRef.current.id, editor);
    applyModelOptions();
    tryRestoreViewState();
    tryReveal(); // first mount happens after the initial file load completes

    // Persist cursor/scroll position without waiting for a tab switch, so a
    // reload right after moving the cursor doesn't lose it. Debounced so
    // rapid cursor/scroll events don't hammer localStorage. These events also
    // fire on model swaps, but stash's URI-match guard makes that a no-op —
    // it only ever writes the CURRENTLY active model's state.
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleFlush = () => {
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        sharedRef.current.persistNow();
      }, 500);
    };
    const cursorSub = editor.onDidChangeCursorPosition(scheduleFlush);
    const scrollSub = editor.onDidScrollChange(scheduleFlush);

    editor.onDidDispose(() => {
      sharedRef.current.onEditorInstance(groupRef.current.id, null);
      // Closes the hole where a disposed instance lingers in editorRef —
      // preview tabs make editor unmount/remount routine, and a stale editorRef
      // would make stash / save / etc. operate on a dead instance.
      if (editorRef.current === editor) editorRef.current = null;
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
      cursorSub.dispose();
      scrollSub.dispose();
    });
  };

  const onChange = (value: string | undefined) => {
    const key = groupRef.current.activeKey;
    if (key) sharedRef.current.setDraft(key, value ?? '');
  };

  // タブ DnD: ドラッグ中は本文全面をオーバーレイで覆い、5 ゾーン
  // (上下左右 = 分割挿入 / 中央 = このグループへ移動) のインジケーターを出す。
  // 全面で dragover を受けるので Monaco がイベントを奪うことはない (TilePane と同じ)。
  const drag = useEditorTabDnd((s) => s.drag);
  const dndEnd = useEditorTabDnd((s) => s.end);
  const [dropZone, setDropZone] = useState<DropZone | null>(null);

  const active = group.activeKey ? (entries[group.activeKey] ?? null) : null;
  // ディスク突き合わせは通常 10〜30ms で終わるので、そのままオーバーレイを出すと
  // ウィンドウを切り替えるたびにチラつく。遅いときだけ見せる。
  const showReloading = useDelayedFlag(!!active?.reloading, RELOAD_OVERLAY_DELAY_MS);

  return (
    <section
      className={`editor-group ${isActiveGroup ? 'active' : ''}`}
      onMouseDownCapture={() => sharedRef.current.focusGroup(group.id)}
      onFocusCapture={() => sharedRef.current.focusGroup(group.id)}
    >
      {group.tabs.length > 0 && (
        <EditorTabsBar
          leafId={shared.leafId}
          group={group}
          entries={entries}
          message={message}
          isActiveGroup={isActiveGroup}
          callbacks={{
            onSwitchTab: (key) => sharedRef.current.switchTab(group.id, key),
            onCloseTab: (key) => sharedRef.current.closeTab(group.id, key),
            onOpenPreview: (path) => sharedRef.current.openPreview(path),
            onSplit: () => sharedRef.current.splitGroup(group.id),
            onDropTab: (index, d) => sharedRef.current.dropOnTabStrip(group.id, index, d),
          }}
        />
      )}
      <div className="editor-group-body">
        {drag !== null && (
          <div
            className="editor-drop-overlay"
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              const z = zoneFromPoint(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY);
              setDropZone((prev) => (prev === z ? prev : z));
            }}
            onDragLeave={() => setDropZone(null)}
            onDrop={(e) => {
              e.preventDefault();
              const d = drag;
              const zone =
                dropZone ??
                zoneFromPoint(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY);
              setDropZone(null);
              dndEnd();
              if (d) sharedRef.current.dropOnEditorZone(groupRef.current.id, zone, d);
            }}
          >
            {dropZone && <div className={`tile-drop-indicator zone-${dropZone}`} />}
          </div>
        )}
        {renderBody(active)}
      </div>
    </section>
  );

  function renderBody(active: FileEntry | null) {
    return (
      <>
      {/* active.kind === 'preview' branches out entirely to MarkdownPreview before any
          of the editor-only checks below run, so <Editor> stays structurally
          unreachable from a preview tab. */}
      {!active ? (
        <div className="placeholder">{t('files.selectFilePlaceholder')}</div>
      ) : active.kind === 'preview' ? (
        <MarkdownPreview
          root={shared.root}
          path={active.path}
          source={active.file?.content ?? null}
          error={active.error}
          tooLarge={active.file?.tooLarge}
          binary={active.file?.binary}
          onRefresh={() => sharedRef.current.refreshPreview(active.key, active.path)}
          onOpenPreview={(path) => sharedRef.current.openPreview(path)}
          onOpenFile={(path) => sharedRef.current.openFile(path)}
          scrollPositions={previewScrollPositionsRef.current}
        />
      ) : active.error ? (
        <div className="placeholder">⚠ {active.error}</div>
      ) : !active.file ? (
        <div className="placeholder">{t('common.loading')}</div>
      ) : active.file.binary ? (
        <div className="placeholder">
          {t('files.binaryFileMessageWithSize', { size: active.file.size })}
        </div>
      ) : active.file.tooLarge ? (
        <div className="placeholder">
          {t('files.tooLargeMessageWithSize', {
            size: Math.round(active.file.size / 1024),
          })}
        </div>
      ) : (
        <>
          {active.conflict ? (
            // 編集中に外部で変更された。どちらを採るかはユーザーにしか決められないので、
            // 非モーダルのバナーで選ばせる (複数グループが同時に衝突しても邪魔にならない)。
            <div className="editor-conflict">
              <span>⚠ {t('files.diskChangedConflict')}</span>
              <button
                type="button"
                onClick={() =>
                  sharedRef.current.applyDiskVersion(active.key, editorRef.current)
                }
              >
                {t('files.loadLatestDiscardingEdits')}
              </button>
              <button type="button" onClick={() => sharedRef.current.dismissDiskChange(active.key)}>
                {t('files.keepEditing')}
              </button>
            </div>
          ) : (
            active.warning && <div className="editor-warning">⚠ {t(active.warning)}</div>
          )}
          <div className="editor-host">
            {showReloading && (
              <div className="editor-reload-overlay">{t('common.loading')}</div>
            )}
            {/* Uncontrolled on purpose: passing `value` makes the library rewrite the
                whole model whenever a re-render (e.g. the 4s repo poll) races a
                keystroke, which jumps the cursor and corrupts IME composition.
                State only mirrors the editor via onChange; models are dropped when the
                LAST group reference closes (disposeKeys) so stale drafts never resurface. */}
            <Editor
              path={shared.modelPath(active.path)}
              defaultValue={active.draft}
              onChange={onChange}
              onMount={onMount}
              keepCurrentModel
              theme={monacoThemeName(resolvedTheme)}
              options={EDITOR_OPTIONS}
            />
          </div>
        </>
      )}
      </>
    );
  }
}
