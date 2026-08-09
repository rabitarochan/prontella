import { useCallback } from 'react';
import { useLang, type Lang } from './langStore';
import { STRINGS, type StringKey } from './strings';

// t():   イベントハンドラーやコンポーネント外から使う (呼び出し時点の言語で解決)。
// useT(): コンポーネントの描画内で使う (言語切替で再描画される)。
// プレースホルダーは {name} 形式: t('git.branchCreated', { name }) など。

export type { Lang, StringKey };
export { useLang };

export function translate(
  lang: Lang,
  key: StringKey,
  params?: Record<string, string | number>,
): string {
  let s: string = STRINGS[key][lang];
  if (params) {
    for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}

export function t(key: StringKey, params?: Record<string, string | number>): string {
  return translate(useLang.getState().lang, key, params);
}

/** 経過時間の表示 (AttentionBell / デッキヒーロー共通)。 */
export function formatElapsed(lang: Lang, since: number, now: number): string {
  const s = Math.max(0, Math.floor((now - since) / 1000));
  if (s < 60) return translate(lang, 'time.seconds', { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return translate(lang, 'time.minutes', { n: m });
  return translate(lang, 'time.hoursMinutes', { h: Math.floor(m / 60), m: m % 60 });
}

export function useT(): (key: StringKey, params?: Record<string, string | number>) => string {
  const lang = useLang((s) => s.lang);
  return useCallback(
    (key: StringKey, params?: Record<string, string | number>) => translate(lang, key, params),
    [lang],
  );
}
