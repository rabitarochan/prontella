import { useEffect } from 'react';
import { getActiveFilesTab, type FilesTabHandle } from './registry';

/**
 * VS Code-style search hotkeys, window-wide while some files view is visible:
 *   Ctrl+P       → Quick Open (fuzzy file name search)
 *   Ctrl+Shift+F → text search panel in the target FilesTab
 * Captured before Monaco (which binds neither chord); plain Ctrl+F stays
 * Monaco's find. With a terminal focused the keys pass through to the shell,
 * and with no files view visible the browser defaults (print) stay intact.
 */
export function useSearchHotkeys(openQuickOpen: (target: FilesTabHandle) => void): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      const key = e.key.toLowerCase();
      const isQuickOpen = key === 'p' && !e.shiftKey;
      const isTextSearch = key === 'f' && e.shiftKey;
      if (!isQuickOpen && !isTextSearch) return;
      if ((e.target as HTMLElement | null)?.closest?.('.xterm')) return;
      const tab = getActiveFilesTab();
      if (!tab) return;
      e.preventDefault(); // suppress Chrome's print dialog for Ctrl+P
      e.stopPropagation();
      if (isQuickOpen) openQuickOpen(tab);
      else tab.showSearchPanel();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [openQuickOpen]);
}
