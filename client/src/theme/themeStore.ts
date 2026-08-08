import { create } from 'zustand';

// テーマ設定ストア。mode(ユーザー選択: light/dark/system)と resolved(実際に適用
// される light/dark)を保持し、documentElement の .dark クラスと color-scheme を
// 同期する。index.html の inline script が初回ペイント前に同じ判定で .dark を
// 先行適用している(FOUC 対策)ため、キー名や値の解釈を変えるときは両方を揃えること。

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'deck3.theme';

// jsdom(vitest)には matchMedia がないため、無い環境ではダーク固定のスタブに落とす
const media: Pick<MediaQueryList, 'matches' | 'addEventListener'> =
  typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : { matches: true, addEventListener: () => {} };

function loadMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system';
  } catch {
    return 'system';
  }
}

function resolve(mode: ThemeMode): ResolvedTheme {
  if (mode === 'system') return media.matches ? 'dark' : 'light';
  return mode;
}

function apply(resolved: ResolvedTheme): void {
  document.documentElement.classList.toggle('dark', resolved === 'dark');
  document.documentElement.style.colorScheme = resolved;
}

interface ThemeState {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
}

export const useTheme = create<ThemeState>((set) => {
  const mode = loadMode();
  const resolved = resolve(mode);
  apply(resolved);
  return {
    mode,
    resolved,
    setMode: (next) => {
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // private mode etc.
      }
      const r = resolve(next);
      apply(r);
      set({ mode: next, resolved: r });
    },
  };
});

// OS 設定変更への追従(mode === 'system' のときのみ反映)。
// モジュールスコープで 1 本だけ購読する(React StrictMode の二重 effect を回避)。
media.addEventListener('change', () => {
  const { mode, resolved } = useTheme.getState();
  if (mode !== 'system') return;
  const next = resolve('system');
  if (next === resolved) return;
  apply(next);
  useTheme.setState({ resolved: next });
});
