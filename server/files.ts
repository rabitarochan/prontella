import fs from 'node:fs';
import path from 'node:path';
import { decodeBuffer, encodeText } from './encoding.js';
import { resolveEditorConfig, type EditorConfigSettings } from './editorconfig.js';

// server/git.ts の blame (getBlame/decodeBlameContent) も同じ閾値を使う(6.5R 指摘 R-3 —
// エディターが開けないファイルを blame では丸ごと読めてしまう非対称を閉じるため export する)。
export const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB
// エディターのテキスト上限(MAX_FILE_SIZE)とは無関係な別定数。画像は Markdown プレビューで
// 表示するだけでパースはしないため、テキストより緩い上限を独立に持つ。
export const MAX_RAW_SIZE = 10 * 1024 * 1024; // 10MB
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

// client/src/types.ts の FileContent と手動同期(共有型機構がないため)
export interface FileContent {
  path: string;
  content: string | null;
  binary: boolean;
  tooLarge: boolean;
  size: number;
  encoding: string | null; // binary / tooLarge のとき null
  hasBom: boolean;
  editorconfig: EditorConfigSettings | null;
}

export function readFileContent(root: string, rel: string, forcedEncoding?: string): FileContent {
  const abs = safeResolve(root, rel);
  const stat = fs.statSync(abs);
  // editorconfig は binary / tooLarge でも返す(新規ファイルのデフォルト決定に使う)
  const editorconfig = resolveEditorConfig(root, abs);
  const base = { path: rel, size: stat.size, hasBom: false, editorconfig };
  if (stat.size > MAX_FILE_SIZE) {
    return { ...base, content: null, binary: false, tooLarge: true, encoding: null };
  }
  const decoded = decodeBuffer(fs.readFileSync(abs), forcedEncoding);
  if (!decoded) {
    return { ...base, content: null, binary: true, tooLarge: false, encoding: null };
  }
  return {
    ...base,
    content: decoded.content,
    binary: false,
    tooLarge: false,
    encoding: decoded.encoding,
    hasBom: decoded.hasBom,
  };
}

/** タブの editorconfig スナップショット再取得用(.editorconfig 保存時に開いているタブへ反映するため)。 */
export function editorConfigFor(root: string, rel: string): EditorConfigSettings | null {
  return resolveEditorConfig(root, safeResolve(root, rel));
}

export function writeFileContent(
  root: string,
  rel: string,
  content: string,
  encoding = 'utf-8',
  bom = false,
): void {
  const abs = safeResolve(root, rel);
  fs.writeFileSync(abs, encodeText(content, encoding, bom));
}

/** Create an empty file. Fails if it already exists. */
export function createFile(root: string, rel: string): void {
  const abs = safeResolve(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, '', { flag: 'wx' }); // wx: error out if the file exists
}

/** Create a directory. Fails if it already exists. */
export function createDir(root: string, rel: string): void {
  const abs = safeResolve(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.mkdirSync(abs); // throws EEXIST if the directory already exists
}

// ---- raw file serving (GET /api/fs/raw、Markdown プレビューのローカル画像用) --------------

// 許可拡張子のみ MIME を返すホワイトリスト(拡張子偽装で任意ファイルを画像として配信させない防壁)。
const RAW_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
};

/** 拡張子から配信用 MIME を引く純関数。ホワイトリスト外(拡張子無し含む)は null。 */
export function rawMimeFor(name: string): string | null {
  const ext = path.extname(name).toLowerCase();
  if (!ext) return null;
  return RAW_MIME_BY_EXT[ext] ?? null;
}

export type ResolveRawFileResult =
  | { ok: true; abs: string; mime: string; size: number }
  | { ok: false; status: 400; error: string }
  | { ok: false; status: 404; error: string }
  | { ok: false; status: 413; error: string }
  | { ok: false; status: 415; error: string };

/**
 * GET /api/fs/raw の検証をまとめた純関数寄りのヘルパー(checkApplyHunksRequest と同じ流儀:
 * ルートテスト基盤が無いため、400/404/413/415 の判定をタグ付き戻り値として切り出し vitest で
 * 直接固定する)。root 外参照(400)を最優先で弾いてから拡張子(415)・存在(404)・サイズ(413)を
 * 見る — この順序でないと、root 外の非画像パスが 415(存在確認前)として漏れてしまう。
 */
export function resolveRawFile(root: string, rel: string): ResolveRawFileResult {
  let abs: string;
  try {
    abs = safeResolve(root, rel);
  } catch {
    return { ok: false, status: 400, error: 'パスがルート外を指しています' };
  }

  const mime = rawMimeFor(rel);
  if (!mime) {
    return { ok: false, status: 415, error: '画像として配信できない拡張子です' };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return { ok: false, status: 404, error: 'ファイルが見つかりません' };
  }
  if (!stat.isFile()) {
    return { ok: false, status: 404, error: 'ファイルが見つかりません' };
  }
  if (stat.size > MAX_RAW_SIZE) {
    return { ok: false, status: 413, error: 'ファイルサイズが上限を超えています' };
  }

  return { ok: true, abs, mime, size: stat.size };
}
