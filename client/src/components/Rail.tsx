import { getActiveFilesTab, type FilesTabHandle } from '../search/registry';
import { useDeck } from '../store';
import AttentionBell from './AttentionBell';
import Sidebar from './Sidebar';
import ThemeToggle from './ThemeToggle';

/**
 * 左ペイン (レール): タイトル行 (ロゴ = デッキへ戻る / ベル / テーマ) +
 * 検索・コマンドバー + リポジトリーナビ (Sidebar)。旧 topbar の要素はここに集約。
 */
export default function Rail({
  onOpenQuickOpen,
}: {
  onOpenQuickOpen: (target: FilesTabHandle) => void;
}) {
  const select = useDeck((s) => s.select);

  // P8-6 でグローバルコマンドパレット (Ctrl+K) に置き換えるまでの暫定:
  // Ctrl+P (Quick Open) と同じ経路を開く。ファイルビューが無い画面では何もしない。
  const openSearch = () => {
    const tab = getActiveFilesTab();
    if (tab) onOpenQuickOpen(tab);
  };

  return (
    <aside className="rail">
      <div className="rail-title">
        <button className="rail-logo" title="デッキへ戻る" onClick={() => select(null)}>
          <span className="rail-logo-mark">◆</span> Claude Deck
        </button>
        <span className="rail-title-actions">
          <AttentionBell />
          <ThemeToggle />
        </span>
      </div>
      <button className="rail-search" title="ファイル検索 (Ctrl+P)" onClick={openSearch}>
        <span className="codicon codicon-search" />
        <span className="rail-search-label">検索・コマンド</span>
        <kbd className="rail-search-kbd">Ctrl+P</kbd>
      </button>
      <Sidebar />
    </aside>
  );
}
