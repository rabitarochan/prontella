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

const cache = new Map<string, FileListEntry>(); // key = worktree root

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

export function getCachedFileList(root: string): FileListEntry | null {
  return cache.get(root) ?? null;
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
  cache.set(root, entry);
  return entry;
}
