import { create } from 'zustand';
import type { TabKind } from '../editorState';

/**
 * ファイルタブ DnD (エディターグループの並べ替え/移動/分割作成) のドラッグ状態。
 * tileDnd.ts と同じ動機: dataTransfer.getData は dragover 中に読めない
 * (protected mode) ため、判定は常にこのストアを正とする。leaf をまたぐドロップ
 * (別タイルのファイルパネルへの移動) を判定できるよう sourceLeafId を持つ。
 * タイル DnD (tileDnd) とは独立 — どちらかがドラッグ中はもう一方の dragstart は
 * 発火しない (ドラッグは同時に 1 つ)。
 */
export interface EditorTabDrag {
  sourceLeafId: string;
  sourceGroupId: string;
  /** tabKey(kind, path) */
  key: string;
  kind: TabKind;
  path: string;
}

interface EditorTabDndState {
  drag: EditorTabDrag | null;
  start: (drag: EditorTabDrag) => void;
  end: () => void;
}

export const useEditorTabDnd = create<EditorTabDndState>((set) => ({
  drag: null,
  start: (drag) => set({ drag }),
  end: () => set({ drag: null }),
}));
