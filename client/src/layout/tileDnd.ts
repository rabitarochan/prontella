import { create } from 'zustand';

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
  start: (leafId) => set({ draggingId: leafId }),
  end: () => set({ draggingId: null }),
}));
