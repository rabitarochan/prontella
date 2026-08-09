import type { Lang } from './langStore';

// ファイル / タイル / 検索 / ターミナル系の文字列。strings.ts でマージされる。

export const FILES_STRINGS = {
  // (P8-5 グループ B で追加)
} as const satisfies Record<string, Record<Lang, string>>;
