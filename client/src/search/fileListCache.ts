import fuzzysort from 'fuzzysort';
import { api } from '../api';

/**
 * Per-worktree file list for Quick Open, stale-while-revalidate: the modal
 * shows the cached list instantly and swaps in a fresh one when the refetch
 * lands. Preparing targets at fetch time is what keeps fuzzysort fast on
 * large repositories.
 */
export interface QuickOpenTarget {
  rel: string; // root-relative path, forward slashes
  name: Fuzzysort.Prepared; // basename
  path: Fuzzysort.Prepared; // full relative path
}

export interface FileListEntry {
  targets: QuickOpenTarget[];
}

// key = worktree root, Map insertion order doubles as LRU order (oldest first) — every
// get/set below re-inserts its key to move it to the end, so cache.keys().next() is
// always the least-recently-used entry.
const cache = new Map<string, FileListEntry>();
const MAX_CACHED_ROOTS = 3; // unbounded growth otherwise: one entry per worktree ever opened

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

export function getCachedFileList(root: string): FileListEntry | null {
  const entry = cache.get(root);
  if (!entry) return null;
  cache.delete(root); // touch: move to most-recently-used position
  cache.set(root, entry);
  return entry;
}

export async function refreshFileList(root: string): Promise<FileListEntry> {
  const { files } = await api.searchFiles(root);
  const entry: FileListEntry = {
    targets: files.map((rel) => ({
      rel,
      name: fuzzysort.prepare(basename(rel)),
      path: fuzzysort.prepare(rel),
    })),
  };
  cache.delete(root); // re-insert below so a refresh of an existing root also counts as a touch
  cache.set(root, entry);
  if (cache.size > MAX_CACHED_ROOTS) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return entry;
}
