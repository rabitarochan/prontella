import { create } from 'zustand';

// 言語設定ストア。themeStore と同じ流儀: zustand + localStorage、
// モジュールスコープで初期化し、React の外(イベントハンドラー内の t())からも
// getState() で読める。既定は navigator.language が ja* なら ja、それ以外は en。

export type Lang = 'ja' | 'en';

const STORAGE_KEY = 'deck3.lang';

function detect(): Lang {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'ja' || raw === 'en') return raw;
  } catch {
    // private mode etc.
  }
  const nav = typeof navigator !== 'undefined' ? (navigator.language ?? 'ja') : 'ja';
  return nav.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

function apply(lang: Lang): void {
  document.documentElement.lang = lang;
}

interface LangState {
  lang: Lang;
  setLang: (lang: Lang) => void;
}

export const useLang = create<LangState>((set) => {
  const lang = detect();
  apply(lang);
  return {
    lang,
    setLang: (next) => {
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // private mode etc.
      }
      apply(next);
      set({ lang: next });
    },
  };
});
