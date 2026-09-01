import { create } from 'zustand';

// VNC メインビューのモード管理。submitKeyStore / themeStore と同じ流儀:
// zustand + localStorage のグローバル UI 設定。
//
// - active: VNC モード中 (リポジトリー未選択で main 全体に VNC を表示)。
//   リポジトリー/worktree を選択すると App 側の effect が false に戻す。
// - visited: 一度でも VNC モードに入ったら true のまま維持する。App は visited に
//   なって初めて VncView をマウントし、以後モードを抜けても display:none で保持する
//   (unmount すると RFB 接続ごと失われるため — タイルの visited-set と同じ不変条件)。

const ACTIVE_KEY = 'prontella.vncActive';

function detectActive(): boolean {
  try {
    return localStorage.getItem(ACTIVE_KEY) === '1';
  } catch {
    return false;
  }
}

interface VncViewState {
  active: boolean;
  visited: boolean;
  setActive: (active: boolean) => void;
}

export const useVncView = create<VncViewState>((set) => ({
  active: detectActive(),
  visited: detectActive(),
  setActive: (active) => {
    try {
      localStorage.setItem(ACTIVE_KEY, active ? '1' : '0');
    } catch {
      // private mode etc.
    }
    set((s) => ({ active, visited: s.visited || active }));
  },
}));
