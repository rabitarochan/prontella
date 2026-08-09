import { useLang, useT } from '../i18n';
import type { Lang } from '../i18n';
import { getActiveFilesTab, type FilesTabHandle } from '../search/registry';
import { useDeck } from '../store';
import AttentionBell from './AttentionBell';
import Sidebar from './Sidebar';
import ThemeToggle from './ThemeToggle';

const LANGS: Lang[] = ['ja', 'en'];

/**
 * 左ペイン (レール): タイトル行 (ロゴ = デッキへ戻る / ベル / 言語 / テーマ) +
 * 検索・コマンドバー + リポジトリーナビ (Sidebar)。旧 topbar の要素はここに集約。
 */
export default function Rail({
  onOpenQuickOpen,
}: {
  onOpenQuickOpen: (target: FilesTabHandle) => void;
}) {
  const t = useT();
  const select = useDeck((s) => s.select);
  const lang = useLang((s) => s.lang);
  const setLang = useLang((s) => s.setLang);

  // P8-6 でグローバルコマンドパレット (Ctrl+K) に置き換えるまでの暫定:
  // Ctrl+P (Quick Open) と同じ経路を開く。ファイルビューが無い画面では何もしない。
  const openSearch = () => {
    const tab = getActiveFilesTab();
    if (tab) onOpenQuickOpen(tab);
  };

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
      <button className="rail-search" title={t('rail.searchTooltip')} onClick={openSearch}>
        <span className="codicon codicon-search" />
        <span className="rail-search-label">{t('rail.searchLabel')}</span>
        <kbd className="rail-search-kbd">Ctrl+P</kbd>
      </button>
      <Sidebar />
    </aside>
  );
}
