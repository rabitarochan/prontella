import { create } from 'zustand';
import { EMPTY_PANE_WIDTHS, sanitizePaneWidths, type PaneKey, type PaneWidths } from './paneWidths';

// ファイルパネル / Git パネルのペイン幅。submitKeyStore / vncViewStore と同じ流儀:
// zustand + localStorage のグローバル UI 設定 (全リポジトリー・全タイル共通)。
//
// 書き込みは Separator のドラッグ確定時 (onLayoutChanged の isUserInteraction) のみ。
// 既にマウント済みの Group は SplitPanel が defaultSize を凍結しているため、
// 別タイルでの変更を remount まで拾わない — タイル分割 / エディター分割と同じ契約
// (凍結する理由は SplitPanel.tsx のコメント)。

const STORAGE_KEY = 'prontella.paneWidths';

function detect(): PaneWidths {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return sanitizePaneWidths(JSON.parse(raw));
  } catch {
    // 壊れた JSON / private mode etc.
  }
  return { ...EMPTY_PANE_WIDTHS };
}

interface PaneWidthState {
  widths: PaneWidths;
  setWidth: (key: PaneKey, pct: number) => void;
}

export const usePaneWidths = create<PaneWidthState>((set, get) => ({
  widths: detect(),
  setWidth: (key, pct) => {
    const next = sanitizePaneWidths({ ...get().widths, [key]: pct });
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // storage full / unavailable — 幅が永続化されないだけ
    }
    set({ widths: next });
  },
}));
