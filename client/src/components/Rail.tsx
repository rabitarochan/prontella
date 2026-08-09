import { useLang, useT } from '../i18n';
import type { Lang } from '../i18n';
import { useDeck } from '../store';
import AttentionBell from './AttentionBell';
import Sidebar from './Sidebar';
import ThemeToggle from './ThemeToggle';

const LANGS: Lang[] = ['ja', 'en'];

/**
 * 左ペイン (レール): タイトル行 (ロゴ = デッキへ戻る / ベル / 言語 / テーマ) +
 * 検索・コマンドバー (Ctrl+K パレット) + リポジトリーナビ (Sidebar)。
 * 旧 topbar の要素はここに集約。
 */
export default function Rail({ onOpenPalette }: { onOpenPalette: () => void }) {
  const t = useT();
  const select = useDeck((s) => s.select);
  const lang = useLang((s) => s.lang);
  const setLang = useLang((s) => s.setLang);

  return (
    <aside className="rail">
      <div className="rail-title">
        <button className="rail-logo" title={t('rail.backToDeck')} onClick={() => select(null)}>
          <span className="rail-logo-mark">◆</span> Claude Deck
        </button>
        <span className="rail-title-actions">
          <AttentionBell />
          <span className="rail-lang" title={t('rail.langTooltip')}>
            {LANGS.map((l) => (
              <button
                key={l}
                className={`rail-lang-btn ${lang === l ? 'active' : ''}`}
                onClick={() => setLang(l)}
              >
                {l.toUpperCase()}
              </button>
            ))}
          </span>
          <ThemeToggle />
        </span>
      </div>
      <button className="rail-search" title={t('rail.searchTooltip')} onClick={onOpenPalette}>
        <span className="codicon codicon-search" />
        <span className="rail-search-label">{t('rail.searchLabel')}</span>
        <kbd className="rail-search-kbd">Ctrl+K</kbd>
      </button>
      <Sidebar />
    </aside>
  );
}
