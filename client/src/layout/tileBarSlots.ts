import { create } from 'zustand';

/**
 * タイルバー内スロットのレジストリ。TilePane (タイル chrome) がバー中央の
 * スロット DOM を leaf.id で登録し、パネル側 (FilesTab 等、安定ホスト内) が
 * createPortal でヘッダー UI を差し込む。両者は React ツリー上は兄弟
 * (どちらも TileGrid 配下) のため、状態はこのストア経由で受け渡す。
 *
 * TilePane はジオメトリ変更で自由に remount される。React 19 の ref
 * クリーンアップは新旧インスタンスの順序が入れ替わることがあるため、
 * clearSlot は「登録時と同じ要素のときだけ」消す (古い方の遅延クリーン
 * アップが新しい登録を消さないように)。
 */
/** 先頭ゾーン (ツリー列幅) 用スロットのキー接尾辞。メインゾーンは leafId そのまま。 */
export const LEAD_SLOT_SUFFIX = '#lead';

interface TileBarSlotsState {
  slots: Record<string, HTMLElement | null>;
  setSlot: (leafId: string, el: HTMLElement) => void;
  clearSlot: (leafId: string, el: HTMLElement) => void;
}

export const useTileBarSlots = create<TileBarSlotsState>((set) => ({
  slots: {},
  setSlot: (leafId, el) =>
    set((s) => (s.slots[leafId] === el ? s : { slots: { ...s.slots, [leafId]: el } })),
  clearSlot: (leafId, el) =>
    set((s) => (s.slots[leafId] === el ? { slots: { ...s.slots, [leafId]: null } } : s)),
}));
