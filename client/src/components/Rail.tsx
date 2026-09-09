import { useLang, useT } from '../i18n';
import { enterMonitor, enterVnc, exitMonitor, exitVnc } from '../layout/mainMode';
import { useMonitorView } from '../layout/monitorViewStore';
import { useVncView } from '../layout/vncViewStore';
import { useMetricsConfig } from '../metrics';
import { useDeck } from '../store';
import AttentionBell from './AttentionBell';
import Sidebar from './Sidebar';
import ThemeToggle from './ThemeToggle';

/**
 * 左ペイン (レール): タイトル行 (ロゴ = デッキへ戻る / モニター / VNC / ベル / 言語 / テーマ) +
 * 検索・コマンドバー (Ctrl+K パレット) + リポジトリーナビ (Sidebar)。
 * 旧 topbar の要素はここに集約。
 */
export default function Rail({ onOpenPalette }: { onOpenPalette: () => void }) {
  const t = useT();
  const select = useDeck((s) => s.select);
  const lang = useLang((s) => s.lang);
  const setLang = useLang((s) => s.setLang);
  const vncActive = useVncView((s) => s.active);
  const monitorActive = useMonitorView((s) => s.active);
  const metricsTier = useMetricsConfig((s) => s.tier);

  return (
    <aside className="rail">
      <div className="rail-title">
        <button className="rail-logo" title={t('rail.backToDeck')} onClick={() => select(null)}>
          <span className="rail-logo-mark">◆</span> Prontella
        </button>
        <span className="rail-title-actions">
          <button
            className={`icon-btn${monitorActive ? ' monitor-btn-active' : ''}`}
            title={t('monitor.railTooltip')}
            onClick={() => (monitorActive ? exitMonitor() : enterMonitor())}
          >
            <span className="codicon codicon-multiple-windows" />
          </button>
          <button
            className={`icon-btn${vncActive ? ' vnc-btn-active' : ''}`}
            title={t('vnc.railTooltip')}
            onClick={() => (vncActive ? exitVnc() : enterVnc())}
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
          {metricsTier !== 'off' && (
            <span
              className="rail-metrics-dot"
              title={t('metrics.railTooltip', { tier: metricsTier })}
              aria-label={t('metrics.railTooltip', { tier: metricsTier })}
            />
          )}
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
