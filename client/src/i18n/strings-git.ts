import type { Lang } from './langStore';

// Git 系 (GitTab / 変更 / 履歴 / diff / 競合解決 / モーダル) の文字列。
// strings.ts でマージされる。

export const GIT_STRINGS = {
  // (P8-5 グループ C で追加)
} as const satisfies Record<string, Record<Lang, string>>;
