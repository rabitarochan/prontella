// ファイルパネル / Git パネルのペイン幅の純ロジック。React にも localStorage にも
// 依存しないので、ここだけは vitest (node 環境) で守れる — 実際のストアは
// paneWidthStore.ts、描画は FilesTab / GitTab 側。
//
// 値は px ではなく **パーセント** で持つ。react-resizable-panels の
// onLayoutChanged が返す layout は panel id → flexGrow (= 正規化された割合) で、
// SplitTreeView が分割ツリーの sizes に入れているのと同じ数値だから。
// パーセントで持つとタイル/ウィンドウ幅に自動追従するので、狭いタイルのための
// 上限計算を自前で持つ必要がない (下限は Panel の minSize が担保する)。

export interface PaneWidths {
  /** FilesTab の左列 (ファイルツリー / 検索) */
  filesTree: number | null;
  /** GitTab の左サイドバー (ワークスペース / ブランチ / stash / タグ) */
  gitSide: number | null;
  /** GitTab status ビューの変更ファイルリスト */
  gitChanges: number | null;
}

export type PaneKey = keyof PaneWidths;

export const PANE_KEYS: readonly PaneKey[] = ['filesTree', 'gitSide', 'gitChanges'];

/** 一度もリサイズされていない (null) ときの既定割合 (%)。
 *  従来の固定幅 (260 / 240 / 340px) を、代表的なタイル幅で再現する値。 */
export const PANE_DEFAULT_PCT: Record<PaneKey, number> = {
  filesTree: 20,
  gitSide: 18,
  gitChanges: 32,
};

export const EMPTY_PANE_WIDTHS: PaneWidths = {
  filesTree: null,
  gitSide: null,
  gitChanges: null,
};

/** 2 ペイン分割の Panel initialSize (= マウント時に凍結される defaultSize) を作る。
 *
 *  **両方を返して合計 100% にするのが要点**。react-resizable-panels は各 Panel の
 *  defaultSize を flexGrow に変換したうえで **全パネルで正規化**する。片方だけ指定して
 *  もう片方を `"100%"` のままにすると、20% は 20/(20+100) = 16.7% に縮む
 *  (実測 2026-09-02: ツリー列が 260px 相当のつもりで 216px になった)。
 *  SplitTreeView が分割ツリーの sizes を常に合計 100 に正規化しているのと同じ理由。 */
export function paneSplitSizes(pct: number | null, fallbackPct: number): [string, string] {
  const first = pct ?? fallbackPct;
  return [`${first}%`, `${100 - first}%`];
}

/** 0 < pct < 100 の有限数だけを通す。範囲外・非数値は「未設定」に落とす。 */
function sanitizePct(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  if (raw <= 0 || raw >= 100) return null;
  return raw;
}

/** localStorage から読んだ値の防御的検証 (editorState.ts の sanitize 群と同じ流儀)。
 *  壊れたキーは **そのキーだけ** 未設定に落とし、他のペインの設定は巻き添えにしない。 */
export function sanitizePaneWidths(raw: unknown): PaneWidths {
  if (typeof raw !== 'object' || raw === null) return { ...EMPTY_PANE_WIDTHS };
  const src = raw as Record<string, unknown>;
  const out = { ...EMPTY_PANE_WIDTHS };
  for (const key of PANE_KEYS) {
    out[key] = sanitizePct(src[key]);
  }
  return out;
}
