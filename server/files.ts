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

// ---- rename / copy / reveal (ツリーのコンテキストメニュー用) ------------------------------

/**
 * リネーム後の名前として妥当なら null、不正ならエラーメッセージを返す純関数。
 * newName は自由入力 — 区切り文字を含む名前は「同一ディレクトリー内のリネーム」から
 * 逸脱する(親をまたぐ移動や safeResolve 前の細工)ので、safeResolve に届く前に弾く。
 */
export function invalidEntryName(name: unknown): string | null {
  if (typeof name !== 'string' || name.trim() === '') return '名前が必要です';
  const trimmed = name.trim();
  if (trimmed.includes('/') || trimmed.includes('\\')) return '名前に / や \\ は使えません';
  if (trimmed === '.' || trimmed === '..') return `不正な名前です: ${JSON.stringify(trimmed)}`;
  return null;
}

/**
 * `rel` を同一ディレクトリー内で `newName` にリネームし、新しい相対パス(forward slash)を返す。
 * 既存パスへの上書きは拒否する。ただし Windows の case-only リネーム(Foo.ts → foo.ts)は
 * existsSync が true を返すため、旧・新の解決先が同一(大文字小文字のみ違う)ときに限り許可する。
 */
export function renameEntry(root: string, rel: string, newName: string): string {
  const invalid = invalidEntryName(newName);
  if (invalid) throw new Error(invalid);
  const name = newName.trim();
  const oldAbs = safeResolve(root, rel);
  if (!fs.existsSync(oldAbs)) throw new Error('対象が見つかりません');
  const relPosix = rel.replace(/\\/g, '/');
  const slash = relPosix.lastIndexOf('/');
  const newRel = slash === -1 ? name : `${relPosix.slice(0, slash)}/${name}`;
  const newAbs = safeResolve(root, newRel);
  const caseOnly = oldAbs !== newAbs && oldAbs.toLowerCase() === newAbs.toLowerCase();
  if (newAbs === oldAbs) return newRel; // 名前が実質変わらない
  if (!caseOnly && fs.existsSync(newAbs)) throw new Error(`既に存在します: ${name}`);
  fs.renameSync(oldAbs, newAbs);
  return newRel;
}

/**
 * VS Code 風の複製名を決める純関数: `foo.ext` → `foo copy.ext` → `foo copy 2.ext` …。
 * 拡張子は path.extname 準拠(`.env` は拡張子なし扱い → `.env copy` になる)。
 */
export function duplicateName(name: string, exists: (candidate: string) => boolean): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? `${stem} copy${ext}` : `${stem} copy ${i}${ext}`;
    if (!exists(candidate)) return candidate;
  }
}

/**
 * `rel` を同一ディレクトリー内に複製し、新しい相対パス(forward slash)を返す。
 * 名前は duplicateName で衝突しない兄弟名を選ぶ。ディレクトリーは再帰コピー。
 * 決定と作成の間のレース対策として作成側でも既存を拒否する(COPYFILE_EXCL / errorOnExist)。
 */
export async function copyEntry(root: string, rel: string): Promise<string> {
  const srcAbs = safeResolve(root, rel);
  const stat = fs.statSync(srcAbs);
  const relPosix = rel.replace(/\\/g, '/');
  const slash = relPosix.lastIndexOf('/');
  const parentRel = slash === -1 ? '' : relPosix.slice(0, slash);
  const name = slash === -1 ? relPosix : relPosix.slice(slash + 1);
  const parentAbs = path.dirname(srcAbs);
  const newName = duplicateName(name, (candidate) => fs.existsSync(path.join(parentAbs, candidate)));
  const newRel = parentRel ? `${parentRel}/${newName}` : newName;
  const dstAbs = safeResolve(root, newRel);
  if (stat.isDirectory()) {
    await fs.promises.cp(srcAbs, dstAbs, { recursive: true, errorOnExist: true, force: false });
  } else {
    fs.copyFileSync(srcAbs, dstAbs, fs.constants.COPYFILE_EXCL);
  }
  return newRel;
}

/**
 * `rel` を削除する(ディレクトリーは再帰)。root 自体の削除は拒否する
 * (rel='' や '.' が root に解決されるため、safeResolve だけでは防げない)。
 * 対象が無ければ statSync の ENOENT がそのまま上がる。
 */
export function deleteEntry(root: string, rel: string): void {
  const abs = safeResolve(root, rel);
  if (abs === path.resolve(root)) throw new Error('ルート自体は削除できません');
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) fs.rmSync(abs, { recursive: true });
  else fs.rmSync(abs);
}

export type ResolveRevealResult =
  | { ok: true; abs: string }
  | { ok: false; status: 400 | 404; error: string };

/**
 * POST /api/fs/reveal の検証ヘルパー(resolveRawFile と同じ流儀: 判定をタグ付き戻り値に
 * 切り出して vitest で固定し、ルートには explorer 起動の副作用だけを残す)。
 * root 外(400)を先に弾いてから存在(404)を見る。
 */
export function resolveRevealTarget(root: string, rel: string): ResolveRevealResult {
  let abs: string;
  try {
    abs = safeResolve(root, rel);
  } catch {
    return { ok: false, status: 400, error: 'パスがルート外を指しています' };
  }
  if (!fs.existsSync(abs)) {
    return { ok: false, status: 404, error: '対象が見つかりません' };
  }
  return { ok: true, abs };
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
