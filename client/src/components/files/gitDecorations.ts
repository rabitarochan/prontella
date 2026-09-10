import * as monaco from 'monaco-editor';
import type { LineChange } from '../../lineDiff';

/**
 * ガター差分 (VS Code の dirty diff 相当) の装飾を Monaco モデルへ適用する。
 *
 * **editor ではなく model に張る**のが肝。モデルは leaf 内のエディターグループ全体で
 * 共有される (useFileEntries の modelPath = `${leafId}/${path}`) ため、
 * editor.createDecorationsCollection で張るとグループを分割した数だけ装飾が重なる。
 * model.deltaDecorations なら「1 モデル 1 セット」になり、どのグループから見ても同じ。
 *
 * 旧 id はモデルに紐づけて WeakMap で持つ。モデルが破棄されればエントリーも回収される
 * ので、明示的な解放漏れでリークしない (dispose 時の clear は別途 useGitGutter が行う)。
 */

const applied = new WeakMap<monaco.editor.ITextModel, string[]>();

/**
 * overview ruler の色は CSS 変数を解決できない (Monaco が canvas へ直接描くため) ので、
 * ここに実値を持つ。**client/src/index.css の --git-gutter-* と手動同期すること**
 * (プロジェクト内の他の手動同期と同じ扱い)。値は VS Code の editorGutter.*Background 系。
 */
const RULER_COLORS = {
  light: { add: '#2ea043', modify: '#0c7d9d', delete: '#e51400' },
  dark: { add: '#3fb950', modify: '#0c7d9d', delete: '#f14c4c' },
} as const;

export type DecorationTheme = keyof typeof RULER_COLORS;

function optionsFor(
  kind: LineChange['kind'],
  theme: DecorationTheme,
): monaco.editor.IModelDecorationOptions {
  return {
    // 行番号の左のガター帯。実際の見た目は styles.css の .git-gutter* が持つ。
    linesDecorationsClassName: `git-gutter git-gutter-${kind}`,
    overviewRuler: {
      color: RULER_COLORS[theme][kind],
      position: monaco.editor.OverviewRulerLane.Left,
    },
    // 行頭で入力しても装飾が勝手に伸びないようにする (次の再計算で正しい範囲に置き換わる)。
    stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
  };
}

/** 変更一覧をモデルへ反映する。null / 空配列を渡せば装飾を全消しする。 */
export function applyGitDecorations(
  model: monaco.editor.ITextModel,
  changes: LineChange[] | null,
  theme: DecorationTheme,
): void {
  if (model.isDisposed()) return;
  const lineCount = model.getLineCount();
  const next: monaco.editor.IModelDeltaDecoration[] = [];
  for (const c of changes ?? []) {
    // 計算に使ったスナップショットとモデルの現在内容がずれていることがある
    // (デバウンス中にさらに入力された)。範囲外を渡すと Monaco が例外を投げるのでクランプする。
    const start = Math.max(1, Math.min(c.startLine, lineCount));
    const end = Math.max(start, Math.min(c.endLine, lineCount));
    next.push({
      range: new monaco.Range(start, 1, end, 1),
      options: optionsFor(c.kind, theme),
    });
  }
  const prev = applied.get(model) ?? [];
  applied.set(model, model.deltaDecorations(prev, next));
}

/** モデルから装飾を取り除く (タブを閉じた / 追跡対象外になった)。 */
export function clearGitDecorations(model: monaco.editor.ITextModel): void {
  if (model.isDisposed()) {
    applied.delete(model);
    return;
  }
  const prev = applied.get(model);
  if (prev && prev.length > 0) model.deltaDecorations(prev, []);
  applied.delete(model);
}
