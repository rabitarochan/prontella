/**
 * Registry of mounted FilesTab instances, so window-level hotkeys (Ctrl+P /
 * Ctrl+Shift+F) can find "the files view the user is working in". Plain
 * module state — only the keydown handler reads it, nothing subscribes.
 */
export interface FilesTabHandle {
  id: string;
  root: string;
  /** False while the tile shows another view (TileWorkspace uses display:none). */
  isVisible: () => boolean;
  openFile: (path: string) => void;
  openAtLine: (path: string, line: number, column?: number) => void;
  /** Editor tabs only — a preview tab (see editorState.ts's TabKind) isn't "a file open
   *  for editing" in the sense Ctrl+P callers care about. */
  getOpenTabPaths: () => string[];
  showSearchPanel: () => void;
}

const handles = new Map<string, FilesTabHandle>(); // insertion order = mount order
const touchedAt = new Map<string, number>();

export function registerFilesTab(handle: FilesTabHandle): void {
  handles.set(handle.id, handle);
}

export function unregisterFilesTab(id: string): void {
  handles.delete(id);
  touchedAt.delete(id);
}

export function touchFilesTab(id: string): void {
  touchedAt.set(id, Date.now());
}

/** Most recently touched visible FilesTab, else the first visible one. */
export function getActiveFilesTab(): FilesTabHandle | null {
  let best: FilesTabHandle | null = null;
  let bestTouched = -1;
  for (const handle of handles.values()) {
    if (!handle.isVisible()) continue;
    const touched = touchedAt.get(handle.id) ?? 0;
    if (best === null || touched > bestTouched) {
      best = handle;
      bestTouched = touched;
    }
  }
  return best;
}
