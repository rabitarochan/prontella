import { create } from 'zustand';

// エージェント入力欄の送信キー方式。langStore / themeStore と同じ流儀:
// zustand + localStorage のグローバル UI 設定 (全セッション共通)。
//
// - 'enter':     Enter = 送信 / Shift+Enter = 改行 (既定)
// - 'ctrlEnter': Ctrl+Enter = 送信 / Enter = 改行

export type SubmitKeyMode = 'enter' | 'ctrlEnter';

const STORAGE_KEY = 'prontella.agentSubmitKey';

function detect(): SubmitKeyMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'enter' || raw === 'ctrlEnter') return raw;
  } catch {
    // private mode etc.
  }
  return 'enter';
}

interface SubmitKeyState {
  mode: SubmitKeyMode;
  setMode: (mode: SubmitKeyMode) => void;
}

export const useSubmitKey = create<SubmitKeyState>((set) => ({
  mode: detect(),
  setMode: (next) => {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // private mode etc.
    }
    set({ mode: next });
  },
}));
