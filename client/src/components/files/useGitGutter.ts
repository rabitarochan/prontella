import { useCallback, useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor';
import { api } from '../../api';
import { useGitEpoch } from '../../gitEpoch';
import { computeLineChanges, splitLinesForDiff } from '../../lineDiff';
import { useTheme } from '../../theme/themeStore';
import { applyGitDecorations, clearGitDecorations, type DecorationTheme } from './gitDecorations';

/**
 * ファイルパネルのガター差分 (VS Code の dirty diff 相当)。
 * 開いている各ファイルについて **index の内容**を基準に行差分を取り、Monaco のガターと
 * overview ruler へ装飾を出す。入力中も追従する (デバウンスあり)。
 *
 * ## モデルの捕捉を React に乗せない理由
 * 装飾の対象は「今 Monaco が持っているモデル」であって「今描画されているタブ」ではない。
 * エディターグループの分割・プレビューとの往復・タブ切替でコンポーネントは頻繁に
 * 生え変わるが、モデルはそれより長く生きる (keepCurrentModel)。そこで
 * monaco.editor.onDidCreateModel / onWillDisposeModel でモデルの生死を直接追う。
 * これで「どのグループが描画中か」に一切依存しなくなる。
 *
 * ## 比較基準が index である理由
 * VS Code と同じ。`git add` すると装飾が消え、そこからさらに編集すると再び出る。
 * (HEAD 基準にすると、ステージ済みの変更がコミットまで点灯し続ける。)
 */

/** 入力中の再計算間隔。短すぎると大きなファイルで負荷になり、長すぎると追従が鈍い。 */
const RECOMPUTE_DEBOUNCE_MS = 250;

interface Tracked {
  path: string;
  /** index 側の行 (未追跡 / バイナリ / サイズ超過なら null = 装飾しない) */
  baseLines: string[] | null;
  disposables: monaco.IDisposable[];
  timer: ReturnType<typeof setTimeout> | undefined;
}

export function useGitGutter(root: string, leafId: string): { refresh: () => void } {
  const resolvedTheme = useTheme((s) => s.resolved);
  const epoch = useGitEpoch((s) => s.epochs[root] ?? 0);

  const trackedRef = useRef(new Map<monaco.editor.ITextModel, Tracked>());
  const rootRef = useRef(root);
  rootRef.current = root;
  const themeRef = useRef<DecorationTheme>(resolvedTheme === 'dark' ? 'dark' : 'light');
  themeRef.current = resolvedTheme === 'dark' ? 'dark' : 'light';
  // base 取得の世代。root 切替や再取得の追い越しで古い応答を捨てるために使う
  // (useFileEntries.syncFromDisk と同じ規律)。
  const seqRef = useRef(new Map<monaco.editor.ITextModel, number>());

  /** そのモデルの現在内容と base から装飾を作り直す。 */
  const recompute = useCallback((model: monaco.editor.ITextModel) => {
    const entry = trackedRef.current.get(model);
    if (!entry || model.isDisposed()) return;
    if (!entry.baseLines) {
      clearGitDecorations(model);
      return;
    }
    const changes = computeLineChanges(entry.baseLines, splitLinesForDiff(model.getValue()));
    applyGitDecorations(model, changes, themeRef.current);
  }, []);

  /** index 側を取り直す。応答が返るまでにモデルが消えていたら捨てる。 */
  const loadBase = useCallback(
    (model: monaco.editor.ITextModel) => {
      const entry = trackedRef.current.get(model);
      if (!entry) return;
      const rootAtStart = rootRef.current;
      const seq = (seqRef.current.get(model) ?? 0) + 1;
      seqRef.current.set(model, seq);
      api
        .indexContent(rootAtStart, entry.path)
        .then((result) => {
          if (seqRef.current.get(model) !== seq) return; // 追い越された
          if (rootRef.current !== rootAtStart) return; // worktree が変わった
          const current = trackedRef.current.get(model);
          if (!current || model.isDisposed()) return;
          current.baseLines =
            result.tracked && result.content !== null ? splitLinesForDiff(result.content) : null;
          recompute(model);
        })
        .catch(() => {
          // git repo でない / 一時的な失敗。装飾を出さないだけで、編集の邪魔はしない。
          const current = trackedRef.current.get(model);
          if (!current || model.isDisposed()) return;
          current.baseLines = null;
          clearGitDecorations(model);
        });
    },
    [recompute],
  );

  const track = useCallback(
    (model: monaco.editor.ITextModel) => {
      if (trackedRef.current.has(model)) return;
      // この leaf のエディターモデルだけを対象にする。URI は `${leafId}/${path}`
      // (useFileEntries.modelPath)。競合解決ペインは `${leafId}-conflict/...` なので
      // 第 1 セグメント完全一致で自然に除外される。
      const uriPath = model.uri.path.replace(/^\//, '');
      const sep = uriPath.indexOf('/');
      if (sep === -1 || uriPath.slice(0, sep) !== leafId) return;
      const path = uriPath.slice(sep + 1);
      if (!path) return;

      const entry: Tracked = { path, baseLines: null, disposables: [], timer: undefined };
      trackedRef.current.set(model, entry);
      entry.disposables.push(
        model.onDidChangeContent(() => {
          if (entry.timer !== undefined) clearTimeout(entry.timer);
          entry.timer = setTimeout(() => {
            entry.timer = undefined;
            recompute(model);
          }, RECOMPUTE_DEBOUNCE_MS);
        }),
      );
      loadBase(model);
    },
    [leafId, loadBase, recompute],
  );

  const untrack = useCallback((model: monaco.editor.ITextModel) => {
    const entry = trackedRef.current.get(model);
    if (!entry) return;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    for (const d of entry.disposables) d.dispose();
    trackedRef.current.delete(model);
    seqRef.current.delete(model);
    clearGitDecorations(model);
  }, []);

  // モデルの生死を購読する。マウント時点で既に存在するモデル (別ビューから戻ってきた等) も拾う。
  useEffect(() => {
    for (const model of monaco.editor.getModels()) track(model);
    const created = monaco.editor.onDidCreateModel(track);
    const disposing = monaco.editor.onWillDisposeModel(untrack);
    return () => {
      created.dispose();
      disposing.dispose();
      for (const model of [...trackedRef.current.keys()]) untrack(model);
    };
  }, [track, untrack]);

  // worktree 切替 / git の状態変化 (stage・commit・ブランチ切替…) で base を取り直す。
  // epoch は gitEpoch ストア経由のプッシュ (ポーリングしない理由はそちらのコメント)。
  useEffect(() => {
    for (const model of trackedRef.current.keys()) loadBase(model);
  }, [root, epoch, loadBase]);

  // テーマ切替。色は装飾オプションに焼かれているので張り直しが要る。
  useEffect(() => {
    for (const model of trackedRef.current.keys()) recompute(model);
  }, [resolvedTheme, recompute]);

  /** ウィンドウ復帰などで呼ぶ手動リフレッシュ (FilesTab のディスク突き合わせに相乗り)。 */
  const refresh = useCallback(() => {
    for (const model of trackedRef.current.keys()) loadBase(model);
  }, [loadBase]);

  return { refresh };
}
