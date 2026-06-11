import fs from 'node:fs';
import path from 'node:path';

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB
const HIDDEN_NAMES = new Set(['.git']);

/** Resolve `rel` under `root`, rejecting traversal outside the root. */
export function safeResolve(root: string, rel: string): string {
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, rel);
  const normalizedRoot = process.platform === 'win32' ? rootAbs.toLowerCase() : rootAbs;
  const normalizedAbs = process.platform === 'win32' ? abs.toLowerCase() : abs;
  if (normalizedAbs !== normalizedRoot && !normalizedAbs.startsWith(normalizedRoot + path.sep)) {
    throw new Error('パスがルート外を指しています');
  }
  return abs;
}

export interface TreeEntry {
  name: string;
  path: string; // relative to root, forward slashes
  type: 'dir' | 'file';
  size: number;
}

export function listDir(root: string, rel: string): TreeEntry[] {
  const abs = safeResolve(root, rel);
  const entries = fs.readdirSync(abs, { withFileTypes: true });
  const result: TreeEntry[] = [];
  for (const entry of entries) {
    if (HIDDEN_NAMES.has(entry.name)) continue;
    const relPath = (rel ? rel.replace(/\\/g, '/') + '/' : '') + entry.name;
    if (entry.isDirectory()) {
      result.push({ name: entry.name, path: relPath, type: 'dir', size: 0 });
    } else if (entry.isFile()) {
      let size = 0;
      try {
        size = fs.statSync(path.join(abs, entry.name)).size;
      } catch {
        // ignore stat races
      }
      result.push({ name: entry.name, path: relPath, type: 'file', size });
    }
  }
  result.sort((a, b) =>
    a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, 'ja'),
  );
  return result;
}

export interface FileContent {
  path: string;
  content: string | null;
  binary: boolean;
  tooLarge: boolean;
  size: number;
}

export function readFileContent(root: string, rel: string): FileContent {
  const abs = safeResolve(root, rel);
  const stat = fs.statSync(abs);
  if (stat.size > MAX_FILE_SIZE) {
    return { path: rel, content: null, binary: false, tooLarge: true, size: stat.size };
  }
  const buf = fs.readFileSync(abs);
  if (buf.includes(0)) {
    return { path: rel, content: null, binary: true, tooLarge: false, size: stat.size };
  }
  return { path: rel, content: buf.toString('utf8'), binary: false, tooLarge: false, size: stat.size };
}

export function writeFileContent(root: string, rel: string, content: string): void {
  const abs = safeResolve(root, rel);
  fs.writeFileSync(abs, content, 'utf8');
}
