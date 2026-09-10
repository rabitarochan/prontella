import { create } from 'zustand';

// ファイルツリーの自動リビール (VS Code の explorer.autoReveal 相当)。
// submitKeyStore / paneWidthStore と同じ流儀: zustand + localStorage の
// グローバル UI 設定 (全リポジトリー・全タイル共通)。
//
// paneWidthStore と違い SplitPanel のような凍結が無いので、片方のタイルで
// 切り替えると、既にマウント済みの別タイルの FilesTab にも即座に反映される。

const STORAGE_KEY = 'prontella.filesAutoReveal';

function detect(): boolean {
  try {
    // 既定は ON (VS Code と同じ)。明示的に OFF にしたときだけ '0' が入る。
    return localStorage.getItem(STORAGE_KEY) !== '0';
  } catch {
    // private mode etc.
    return true;
  }
}

interface AutoRevealState {
  on: boolean;
  setOn: (on: boolean) => void;
}

export const useAutoReveal = create<AutoRevealState>((set) => ({
  on: detect(),
  setOn: (on) => {
    try {
      localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
    } catch {
      // storage full / unavailable — 設定が永続化されないだけ
    }
    set({ on });
  },
}));
