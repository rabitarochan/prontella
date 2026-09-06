import { create } from 'zustand';
import { setOverlayInert } from '../components/vscode/overlayHost';

/**
 * タイル DnD (レイアウト再構成) のドラッグ状態。Sidebar のリポジトリー DnD と
 * 同じく「ドラッグ中の id はグローバルに 1 つ」だが、全 TilePane がオーバーレイの
 * 表示切替で再描画される必要があるため、モジュール変数ではなく zustand で持つ。
 * dataTransfer.getData は dragover 中に読めない (protected mode) ため、判定は
 * 常にこのストアを正とする。
 */
interface TileDndState {
  draggingId: string | null;
  start: (leafId: string) => void;
  end: () => void;
}

export const useTileDnd = create<TileDndState>((set) => ({
  draggingId: null,
  // VS Code タイルの iframe はポインターイベントを飲むので、ドラッグ中は
  // 素通しにしないとドロップゾーンが反応しない。
  start: (leafId) => {
    setOverlayInert(true);
    set({ draggingId: leafId });
  },
  end: () => {
    setOverlayInert(false);
    set({ draggingId: null });
  },
}));
