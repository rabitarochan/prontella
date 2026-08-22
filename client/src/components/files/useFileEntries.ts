// ファイル実行時状態のプール (leaf に 1 つ)。キーは tabKey(kind, path)。
// グループツリー (editorGroups.ts) はタブ参照だけを持ち、内容・draft・dirty・
// エラーは全てこのプールにある — 同一ファイルを複数グループで開いても
// エントリー (と Monaco モデル) は 1 つで、編集・保存・dirty 表示が自然に共有される。
//
// FilesTab.tsx (コーディネーター) から移設したロジックの持ち主:
// load/reconcile・save (formatOnSave / .editorconfig 再取得含む)・
// エンコーディング指定リロード・path 単位のリソース参照 (indent/EOL override・
// 復元待ち draft・viewState) と一括破棄 (disposeKeys)。

import { useCallback, useRef, useState } from 'react';
import type { OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { api } from '../../api';
import { hashText, tabKey, type OpenTabRef, type TabKind } from '../../editorState';
import { useT, type StringKey } from '../../i18n';
import type { FileContent } from '../../types';
import { basename } from '../editorTabs';
import { charsetToEncoding, disposeModelsSoon, formatOnSave } from './monacoSave';

// Tab identity is `{kind, path}` (see editorState.ts's OpenTabRef), not `path` alone — an
// editor tab and a preview tab for the same path are distinct entries. `key` is the derived
// identity string used for React keys / lookups; `path` stays on the entry too since most
// code (api.file, modelPath, viewStates, ...) only ever needs the path.
export interface FileEntry {
  kind: TabKind;
  path: string;
  key: string;
  file: FileContent | null; // null while loading
  draft: string;
  error: string;
  /** Set when a restored draft was applied over disk content that changed while the tab was away. */
  warning: StringKey | '';
}

export type MonacoEditor = Parameters<OnMount>[0];

// Preview tabs have no draft/file-content notion of their own (they render the editor
// tab's — or disk's — content read-only), so dirtiness is an editor-only concept.
export function isDirtyEntry(e: FileEntry | null | undefined): boolean {
  return !!e && e.kind === 'editor' && !!e.file && e.file.content !== null && e.draft !== e.file.content;
}

function placeholderEntry(ref: OpenTabRef): FileEntry {
  return {
    kind: ref.kind,
    path: ref.path,
    key: tabKey(ref.kind, ref.path),
    file: null,
    draft: '',
    error: '',
    warning: '',
  };
}

function entriesFromRefs(refs: OpenTabRef[]): Record<string, FileEntry> {
  const out: Record<string, FileEntry> = {};
  for (const ref of refs) {
    const key = tabKey(ref.kind, ref.path);
    if (!out[key]) out[key] = placeholderEntry(ref);
  }
  return out;
}

export interface FileEntriesInit {
  refs: OpenTabRef[];
  drafts: Record<string, { text: string; baseHash: string }>;
  /** groupId -> path -> viewState (editorState.ts v2 の形のまま保持する) */
  viewStates: Record<string, Record<string, unknown>>;
}

export function useFileEntries(root: string, leafId: string, init: FileEntriesInit) {
  const t = useT();
  const [entries, setEntries] = useState<Record<string, FileEntry>>(() =>
    entriesFromRefs(init.refs),
  );
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const loadedRef = useRef(new Set<string>()); // keys whose load is in flight or done

  // draftsRef holds only RESTORED drafts that loadFile hasn't reconciled yet
  // (see loadFile below) — once an entry finishes loading, its entry here is
  // deleted and the coordinator's flush computes what to persist straight from
  // the live entries instead. So this ref is a "pending restore" queue, not the
  // authoritative draft store.
  const draftsRef = useRef<Record<string, { text: string; baseHash: string }>>(init.drafts);

  // viewState (カーソル位置・スクロール位置) は各グループペインの stash/restore で
  // ライブ管理する。キーは (groupId, path) — 同一ファイルでもグループごとに
  // 別のスクロール位置を持つため。drafts と違い path だけでは足りない。
  const viewStatesRef = useRef<Record<string, Record<string, unknown>>>(init.viewStates);

  // インデント設定を適用済みのモデル(のパス)。モデルは全参照が閉じられると
  // 破棄されるので、disposeKeys / root 切替で該当エントリも消して再適用させる。
  const indentAppliedRef = useRef(new Set<string>());

  // ステータスバーで EOL を明示選択したパスの集合。保存時にこの集合に含まれる
  // パスは formatOnSave の editorconfig 由来 EOL 強制をスキップする(ユーザーの意思が
  // .editorconfig より優先)。indentAppliedRef と同じ寿命管理(全参照 close / root 切替で
  // 削除)。ただし保存成功時にはクリアしない — 同じタブで保存を繰り返しても選択は維持される。
  // モデル共有のため path 単位が正しい (グループ単位ではない)。
  const eolOverrideRef = useRef(new Set<string>());

  const rootRef = useRef(root);
  rootRef.current = root;
  const leafIdRef = useRef(leafId);
  leafIdRef.current = leafId;

  // Monaco models are global and keyed by path; two FilesTab instances (one per tile)
  // opening the same path would otherwise fight over one model and dispose each other's
  // drafts. Namespace every model URI with `leafId` (stable per tile leaf, unique across
  // leaves). Groups within one leaf deliberately SHARE the model (edits sync live), so
  // no group component in the URI.
  const modelPath = useCallback((path: string) => `${leafIdRef.current}/${path}`, []);

  /** Create placeholder entries for refs not in the pool yet. */
  const ensureEntries = useCallback((refs: OpenTabRef[]) => {
    setEntries((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const ref of refs) {
        const key = tabKey(ref.kind, ref.path);
        if (!next[key]) {
          next[key] = placeholderEntry(ref);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  // Load a file's content into its entry. Shared by openTab (user-initiated)
  // and the mount / root-change restore paths (entries whose `file` starts null).
  const loadFile = useCallback(
    (key: string, path: string) => {
      if (loadedRef.current.has(key)) return;
      loadedRef.current.add(key);
      api
        .file(root, path)
        .then((f) => {
          // Reconcile a restored (persisted) draft against the just-loaded disk
          // content. draftsRef is editor-only (keyed by path), so only the editor
          // entry for this path consults it — a preview entry loading the same path
          // must not steal or drop the editor entry's pending restore. Resolved
          // either way below, so drop it from the pending bucket now — the
          // coordinator's flush computation takes over from here for this path.
          const isEditorLoad = key === tabKey('editor', path);
          const pending = isEditorLoad ? draftsRef.current[path] : undefined;
          if (isEditorLoad) delete draftsRef.current[path];

          setEntries((prev) => {
            const e = prev[key];
            if (!e) return prev;
            // R-1 (2026-07-27 レビュー指摘): 成功したロードは必ず前回のエラー表示を
            // クリアする。以前はここで error を引き継いでいたため、一度エラーに
            // なったタブ (プレビューの「更新」・エディターの再読み込み共通) は disk
            // 側が復旧して 200 が返ってきても永久にエラー表示のままだった。
            const base = { ...e, file: f, error: '' };
            let next: FileEntry;
            if (!pending || f.content === null) {
              // No persisted draft to reconcile, or the file can't be
              // edited here (binary/too large) — normal load.
              next = { ...base, draft: f.content ?? '' };
            } else if (f.content === pending.text) {
              // Disk already matches the draft — nothing to restore.
              next = { ...base, draft: f.content };
            } else if (hashText(f.content) === pending.baseHash) {
              // Disk is unchanged from the content the draft was based on
              // — safe to reapply.
              next = { ...base, draft: pending.text };
            } else {
              // Disk changed underneath the draft while the tab was away.
              // Apply the draft anyway (never silently discard it) but warn,
              // since saving now would overwrite the newer disk content.
              next = { ...base, draft: pending.text, warning: 'files.diskChangedWhileAwayWarning' };
            }
            return { ...prev, [key]: next };
          });
        })
        .catch((e: Error) => {
          loadedRef.current.delete(key); // allow retry on reopen
          setEntries((prev) =>
            prev[key] ? { ...prev, [key]: { ...prev[key], error: e.message } } : prev,
          );
        });
    },
    [root],
  );

  // Preview entries render disk content directly (no draft of their own), so a save made
  // through the editor tab isn't visible until the preview's content is refetched. Used
  // by openTab (reactivating an already-open preview tab), switchTo (switching TO a
  // preview tab via the tab strip), and MarkdownPreview's own refresh button.
  // Editor entries never call this — they have their own reload path (reloadWithEncoding).
  const refreshPreviewTab = useCallback(
    (key: string, path: string) => {
      loadedRef.current.delete(key);
      loadFile(key, path);
    },
    [loadFile],
  );

  const setDraft = useCallback((key: string, value: string) => {
    setEntries((prev) => (prev[key] ? { ...prev, [key]: { ...prev[key], draft: value } } : prev));
  }, []);

  // Path/kind-keyed cleanup for entries whose LAST group reference was removed
  // (close / move-away / eviction). Callers compute the orphan set via
  // editorGroups.orphanedKeysAfter — an entry still referenced by another group
  // must NOT be disposed here (that would silently destroy the shared unsaved
  // edit; this is the biggest accident point of the group model). Preview
  // entries have no draft/viewState/model of their own.
  const disposeKeys = useCallback(
    (keys: string[]) => {
      if (keys.length === 0) return;
      const modelPaths: string[] = [];
      for (const key of keys) {
        loadedRef.current.delete(key);
        const sep = key.indexOf(':');
        const kind = key.slice(0, sep) as TabKind;
        const path = key.slice(sep + 1);
        if (kind === 'editor') {
          indentAppliedRef.current.delete(path);
          eolOverrideRef.current.delete(path);
          delete draftsRef.current[path];
          for (const states of Object.values(viewStatesRef.current)) delete states[path];
          modelPaths.push(modelPath(path));
        }
      }
      if (modelPaths.length > 0) disposeModelsSoon(modelPaths);
      setEntries((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const key of keys) {
          if (next[key]) {
            delete next[key];
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    },
    [modelPath],
  );

  // encOverride は「指定エンコーディングで保存」用。非 dirty でも encOverride 付き
  // なら保存する(エンコーディング変換だけの保存を許す)。editor はアクティブ
  // グループのインスタンス — モデル共有なのでどのグループのものでも同じモデルに
  // 整形が乗る。
  const save = useCallback(
    async (key: string, editor: MonacoEditor | null, encOverride?: { encoding: string; bom: boolean }) => {
      const entry = entriesRef.current[key];
      if (!entry || entry.kind !== 'editor' || !entry.file || entry.file.content === null) return;
      const path = entry.path;
      if (entry.draft === entry.file.content && !encOverride) return;
      const ec = entry.file.editorconfig;
      // 新規(空)ファイルに限り editorconfig の charset を保存エンコーディングの
      // デフォルトにする(既存ファイルを勝手に文字コード変換しない)
      const isEmptyFile = entry.file.content === '' && entry.file.size === 0;
      const enc =
        encOverride ??
        (isEmptyFile && ec?.charset
          ? charsetToEncoding(ec.charset)
          : { encoding: entry.file.encoding ?? 'utf-8', bom: entry.file.hasBom });
      setSaving(true);
      try {
        // 保存時整形をモデルに適用してから getValue() を送る。アクティブなモデルが
        // 取れない特殊ケースでは整形をスキップして draft をそのまま送る(安全側)。
        const model = editor?.getModel();
        let content = entry.draft;
        if (model && model.uri.toString() === monaco.Uri.parse(modelPath(path)).toString()) {
          formatOnSave(model, ec, editor?.getSelections() ?? null, eolOverrideRef.current.has(path));
          content = model.getValue();
        }
        await api.saveFile(rootRef.current, path, content, enc);
        setEntries((prev) => {
          const e = prev[key];
          if (!e || !e.file) return prev;
          return {
            ...prev,
            [key]: {
              ...e,
              draft: content,
              file: { ...e.file, content, encoding: enc.encoding, hasBom: enc.bom },
              warning: '', // a successful save resolves any restore-time conflict
            },
          };
        });
        // .editorconfig を保存したら、開いている全「エディター」エントリーの editorconfig
        // スナップショットを再取得して反映する(修正 C — 開いた時点のスナップショットの
        // ままだと保存直後の変更が反映されない)。プレビューには適用対象の
        // editorconfig スナップショットがないので対象外。
        // draft/content/encoding/hasBom には触れない(専用エンドポイントを使うのはこの
        // 未保存編集の破壊を避けるため)。個別の再取得失敗は無視して旧値を保持し、
        // 保存自体の成功扱いは変えない。
        if (basename(path) === '.editorconfig') {
          const updates = await Promise.all(
            Object.values(entriesRef.current)
              .filter((e) => e.kind === 'editor' && e.file !== null)
              .map(async (e) => {
                try {
                  return { path: e.path, editorconfig: await api.editorConfig(rootRef.current, e.path) };
                } catch {
                  return null;
                }
              }),
          );
          setEntries((prev) => {
            const next = { ...prev };
            for (const [k, e] of Object.entries(prev)) {
              if (e.kind !== 'editor') continue;
              const u = updates.find((x) => x?.path === e.path);
              if (u && e.file) next[k] = { ...e, file: { ...e.file, editorconfig: u.editorconfig } };
            }
            return next;
          });
        }
        setMessage(t('files.savedMessage'));
        setTimeout(() => setMessage(''), 2500);
      } catch (e) {
        setMessage(`⚠ ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setSaving(false);
      }
    },
    [modelPath, t],
  );

  // 「エンコーディング指定で再読み込み」の実体。dirty 破棄の確認はコーディネーター
  // (FilesTab) 側で済ませてから呼ぶ。
  const reloadWithEncoding = useCallback(
    async (key: string, editor: MonacoEditor | null, encoding: string) => {
      const entry = entriesRef.current[key];
      if (!entry || entry.kind !== 'editor') return;
      const path = entry.path;
      try {
        const f = await api.file(rootRef.current, path, encoding);
        setEntries((prev) =>
          prev[key]
            ? {
                ...prev,
                // draft is discarded here, so any restore-time conflict no longer applies
                [key]: { ...prev[key], file: f, draft: f.content ?? '', error: '', warning: '' },
              }
            : prev,
        );
        // uncontrolled モデルなので明示的に反映する(URI 一致ガード付き。
        // undo 履歴はリセットされるがリロードなので許容)。インデントも内容が変わったので
        // 再検出させる (ペインの毎レンダー effect が applyModelOptions を再適用する)。
        const model = editor?.getModel();
        if (
          f.content !== null &&
          model &&
          model.uri.toString() === monaco.Uri.parse(modelPath(path)).toString()
        ) {
          model.setValue(f.content);
          indentAppliedRef.current.delete(path);
          eolOverrideRef.current.delete(path);
        }
        setMessage('');
      } catch (e) {
        setMessage(`⚠ ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [modelPath],
  );

  /** Worktree 切替 (root change) 用の全リセット。呼び出し側がロードを再発火する。 */
  const resetAll = useCallback((next: FileEntriesInit) => {
    loadedRef.current.clear();
    indentAppliedRef.current.clear();
    eolOverrideRef.current.clear();
    draftsRef.current = next.drafts;
    viewStatesRef.current = next.viewStates;
    setEntries(entriesFromRefs(next.refs));
    setMessage('');
  }, []);

  return {
    entries,
    entriesRef,
    setEntries,
    saving,
    message,
    setMessage,
    loadedRef,
    draftsRef,
    viewStatesRef,
    indentAppliedRef,
    eolOverrideRef,
    modelPath,
    ensureEntries,
    loadFile,
    refreshPreviewTab,
    setDraft,
    disposeKeys,
    save,
    reloadWithEncoding,
    resetAll,
  };
}

export type FileEntriesApi = ReturnType<typeof useFileEntries>;
