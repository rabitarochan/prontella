import { create } from 'zustand';
import { sanitizePaneWidth } from '../vncState';

// VNC ペイン (右ペイン) の開閉と幅。submitKeyStore / themeStore と同じ流儀:
// zustand + localStorage のグローバル UI 設定。
//
// visited: 一度でも開いたら true のまま維持する。App は visited になって初めて
// VncPane をマウントし、以後は閉じても display:none で保持する (unmount すると
// RFB 接続ごと失われるため — タイルの visited-set と同じ不変条件)。

const OPEN_KEY = 'deck3.vncPaneOpen';
const WIDTH_KEY = 'deck3.vncPaneWidth';

function detectOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function detectWidth(): number {
  try {
    return sanitizePaneWidth(localStorage.getItem(WIDTH_KEY));
  } catch {
    return sanitizePaneWidth(null);
  }
}

interface VncPaneState {
  open: boolean;
  visited: boolean;
  width: number;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  setWidth: (width: number) => void;
}

export const useVncPane = create<VncPaneState>((set) => ({
  open: detectOpen(),
  visited: detectOpen(),
  width: detectWidth(),
  setOpen: (open) => {
    try {
      localStorage.setItem(OPEN_KEY, open ? '1' : '0');
    } catch {
      // private mode etc.
    }
    set((s) => ({ open, visited: s.visited || open }));
  },
  toggle: () => {
    set((s) => {
      const open = !s.open;
      try {
        localStorage.setItem(OPEN_KEY, open ? '1' : '0');
      } catch {
        // private mode etc.
      }
      return { open, visited: s.visited || open };
    });
  },
  setWidth: (width) => {
    const clamped = sanitizePaneWidth(width);
    try {
      localStorage.setItem(WIDTH_KEY, String(clamped));
    } catch {
      // private mode etc.
    }
    set({ width: clamped });
  },
}));
