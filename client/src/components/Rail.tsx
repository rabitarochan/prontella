import { useLang, useT } from '../i18n';
import { useVncView } from '../layout/vncViewStore';
import { useDeck } from '../store';
import AttentionBell from './AttentionBell';
import Sidebar from './Sidebar';
import ThemeToggle from './ThemeToggle';

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
  const vncActive = useVncView((s) => s.active);
  const setVncActive = useVncView((s) => s.setActive);

  // VNC モードへの出入り。入るときはリポジトリー選択を外して main 全体を VNC にする
  // (選択が残っていると App 側の「選択優先」effect が即座にモードを解除してしまう)。
  const toggleVnc = () => {
    if (vncActive) {
      setVncActive(false);
    } else {
      select(null);
      setVncActive(true);
    }
  };

  return (
    <aside className="rail">
      <div className="rail-title">
        <button className="rail-logo" title={t('rail.backToDeck')} onClick={() => select(null)}>
          <span className="rail-logo-mark">◆</span> Claude Deck
        </button>
        <span className="rail-title-actions">
          <button
            className={`icon-btn${vncActive ? ' vnc-btn-active' : ''}`}
            title={t('vnc.railTooltip')}
            onClick={toggleVnc}
          >
            <span className="codicon codicon-vm" />
          </button>
          <AttentionBell />
          {/* モックアップ同様の単一トグル: 現在の言語を表示し、クリックで ja ⇄ en */}
          <button
            className="icon-btn rail-lang-btn"
            title={t('rail.langTooltip')}
            onClick={() => setLang(lang === 'ja' ? 'en' : 'ja')}
          >
            {lang.toUpperCase()}
          </button>
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
