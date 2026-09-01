import { create } from 'zustand';

/**
 * ターミナルタブ DnD (グループ内の並べ替え / グループ間移動 / 端ドロップ分割) の
 * ドラッグ状態。editorTabDnd.ts / tileDnd.ts と同じ動機:
 * dataTransfer.getData は dragover 中に読めない (protected mode) ため、判定は
 * 常にこのストアを正とする。
 *
 * sourceLeafId は「別タイルのターミナルパネルへのドロップ」を弾くために持つ。
 * ターミナルセッションの所有者は tileTree の leaf.sessions なので、leaf をまたぐ
 * 移動は所有権の移転になり本ストアの範囲外 (受け側が leaf 不一致で無視する)。
 */
export interface TermTabDrag {
  sourceLeafId: string;
  sourceGroupId: string;
  sessionId: string;
}

interface TermTabDndState {
  drag: TermTabDrag | null;
  start: (drag: TermTabDrag) => void;
  end: () => void;
}

export const useTermTabDnd = create<TermTabDndState>((set) => ({
  drag: null,
  start: (drag) => set({ drag }),
  end: () => set({ drag: null }),
}));
