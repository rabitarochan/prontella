import { create } from 'zustand';

// ターミナルモニター (全 PTY セッションを 1 画面に並べる main ビュー) のモード管理。
// vncViewStore と同じ流儀 (zustand + Web Storage) だが 2 点違う:
//
// - `visited` は持たない: モードを抜けたらアンマウントしてよい (各タイルは再入場時に
//   snapshot で安価に復元でき、多数の WebSocket / xterm を隠したまま抱え続ける方が高くつく)。
// - 永続化は **sessionStorage** (= ウィンドウ/タブ単位): モニターは「別ウィンドウで
//   常時表示しておき、作業は worktree ページで」という複数ウィンドウ運用が主用途。
//   localStorage だと全ウィンドウで共有され、モニター用ウィンドウで入った状態が
//   作業用ウィンドウのリロード後の復元先まで変えてしまう (2026-09-03 実測)。
//   同じタブのリロードでは sessionStorage も残るので、復元は従来どおり効く。
//
// - active: モニター中 (リポジトリー未選択で main 全体にモニターを表示)。
//   リポジトリー/worktree を選択すると App 側の effect が false に戻す。

const ACTIVE_KEY = 'prontella.monitorActive';

function detectActive(): boolean {
  try {
    return sessionStorage.getItem(ACTIVE_KEY) === '1';
  } catch {
    return false;
  }
}

interface MonitorViewState {
  active: boolean;
  setActive: (active: boolean) => void;
}

export const useMonitorView = create<MonitorViewState>((set) => ({
  active: detectActive(),
  setActive: (active) => {
    try {
      sessionStorage.setItem(ACTIVE_KEY, active ? '1' : '0');
    } catch {
      // private mode etc.
    }
    set({ active });
  },
}));
