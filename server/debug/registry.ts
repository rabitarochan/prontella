import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

/**
 * デバッグアダプターの表・設定検証・起動コマンド解決・自動ダウンロード。server/lsp/registry.ts と同型
 * (一般化はしない)。MVP は `node` (vscode-js-debug) だけ。C# (netcoredbg) を足すときは ADAPTER_IDS と resolve に増やす。
 */

export const ADAPTER_IDS = ['node'] as const;
export type AdapterId = (typeof ADAPTER_IDS)[number];

export function isAdapterId(v: unknown): v is AdapterId {
  return typeof v === 'string' && (ADAPTER_IDS as readonly string[]).includes(v);
}

/** 自動ダウンロードする vscode-js-debug の版 (RESULTS.md の実測はこの版)。上げるときは D1〜D9 を再測定する */
export const JS_DEBUG_VERSION = '1.140.0';
const JS_DEBUG_URL = (ver: string) => `https://github.com/microsoft/vscode-js-debug/releases/download/v${ver}/js-debug-dap-v${ver}.tar.gz`;
/** 展開後の相対位置 (tarball のレイアウト。RESULTS.md D10) */
const JS_DEBUG_ENTRY = path.join('js-debug', 'src', 'dapDebugServer.js');

export interface DebugAdapterConfig {
  /** 明示指定の `dapDebugServer.js` の絶対パス (node で起動する)。無ければ tools / VS Code 拡張 / ダウンロード */
  dapDebugServer?: string;
}
export type DebugConfig = Record<AdapterId, DebugAdapterConfig>;
export const DEFAULT_CONFIG: DebugConfig = { node: {} };

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.codePointAt(i)!;
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** config.json トップレベル "debug" キーの検証 (checkLspConfig と同じ作法)。 */
export function checkDebugConfig(value: unknown): { ok: true; config: DebugConfig } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, config: structuredClone(DEFAULT_CONFIG) };
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'debug はオブジェクトが必要です (例: { "node": { "dapDebugServer": "..." } })' };
  const config = structuredClone(DEFAULT_CONFIG);
  for (const id of ADAPTER_IDS) {
    const v = (value as Record<string, unknown>)[id];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: `debug.${id} はオブジェクトが必要です` };
    const obj = v as Record<string, unknown>;
    if (obj.dapDebugServer !== undefined) {
      if (typeof obj.dapDebugServer !== 'string' || obj.dapDebugServer.length === 0 || hasControlChar(obj.dapDebugServer)) {
        return { ok: false, error: `debug.${id}.dapDebugServer は空でも制御文字を含んでもいけません` };
      }
      config[id].dapDebugServer = obj.dapDebugServer;
    }
  }
  return { ok: true, config };
}

export interface Launch {
  command: string;
  /** 末尾に `<port> <host>` を足して起動する */
  args: string[];
  source: 'config' | 'tools' | 'vscode-ext';
}

export interface ResolveEnv {
  config: DebugAdapterConfig;
  execPath: string;
  home: string;
  /** `~/.prontella/tools` */
  toolsDir: string;
  exists: (abs: string) => boolean;
  listDir: (abs: string) => string[];
}

/** ダウンロード先の `dapDebugServer.js` */
export function toolsEntry(toolsDir: string, version = JS_DEBUG_VERSION): string {
  return path.join(toolsDir, 'js-debug', version, JS_DEBUG_ENTRY);
}

/**
 * 解決順: 1. config の明示指定 2. `~/.prontella/tools/js-debug/<ver>/` 3. VS Code 拡張 `ms-vscode.js-debug-*`
 * (新しい版から。ponytail: 文字列降順) 4. null (= 呼び出し側がダウンロードして 2 を作る)。
 * `.js` は必ず prontella と同じ node (execPath) で起動する — `.cmd` シム問題も PATH 依存も無い
 */
export function resolveAdapter(r: ResolveEnv): Launch | null {
  if (r.config.dapDebugServer) return { command: r.execPath, args: [r.config.dapDebugServer], source: 'config' };
  const tools = toolsEntry(r.toolsDir);
  if (r.exists(tools)) return { command: r.execPath, args: [tools], source: 'tools' };
  const extDir = path.join(r.home, '.vscode', 'extensions');
  for (const name of r.listDir(extDir).filter((n) => n.startsWith('ms-vscode.js-debug-')).sort().reverse()) {
    const candidate = path.join(extDir, name, 'src', 'dapDebugServer.js');
    if (r.exists(candidate)) return { command: r.execPath, args: [candidate], source: 'vscode-ext' };
  }
  return null;
}

export interface DownloadDeps {
  toolsDir: string;
  version?: string;
  fetch?: typeof fetch;
  /** tar.gz を dir に展開する。既定は OS の `tar -xzf` (Windows 10+ / macOS / Linux に同梱) */
  extract?: (archive: string, dir: string) => Promise<void>;
  onStatus?: (text: string) => void;
}

let inflight: Promise<string> | null = null;

/**
 * vscode-js-debug の DAP tarball を `<toolsDir>/js-debug/<ver>/` に置く。戻り値は dapDebugServer.js の絶対パス。
 * 途中失敗の残骸 (`.part` / `.tmp`) を「完成」と誤認しないよう、完成形は最後の rename でだけ現れる。
 * 同時に 2 セッションが始まっても 1 回しか落とさない (single-flight)。
 * ponytail: チェックサム検証は無し (版を固定 + HTTPS)。必要なら release の SHA を JS_DEBUG_VERSION の隣に置く。
 */
export function downloadJsDebug(deps: DownloadDeps): Promise<string> {
  if (inflight) return inflight;
  inflight = doDownload(deps).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function doDownload(deps: DownloadDeps): Promise<string> {
  const version = deps.version ?? JS_DEBUG_VERSION;
  const base = path.join(deps.toolsDir, 'js-debug');
  const dest = path.join(base, version);
  const entry = path.join(dest, JS_DEBUG_ENTRY);
  if (fs.existsSync(entry)) return entry;
  fs.mkdirSync(base, { recursive: true });
  const archive = path.join(base, `${version}.tar.gz`);
  const part = `${archive}.part`;
  const tmp = `${dest}.tmp`;
  const f = deps.fetch ?? fetch;
  deps.onStatus?.(`vscode-js-debug ${version} をダウンロードしています`);
  try {
    const res = await f(JS_DEBUG_URL(version));
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), fs.createWriteStream(part));
    fs.renameSync(part, archive);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    await (deps.extract ?? extractTarGz)(archive, tmp);
    if (!fs.existsSync(path.join(tmp, JS_DEBUG_ENTRY))) throw new Error('展開後に dapDebugServer.js が見つかりません');
    // tarball に package.json が無い。上位に "type":"module" の package.json があると ESM 扱いで即死する (RESULTS.md 前提)
    fs.writeFileSync(path.join(tmp, 'js-debug', 'package.json'), '{"type":"commonjs"}\n');
    fs.renameSync(tmp, dest);
    return entry;
  } finally {
    for (const p of [part, archive]) fs.rmSync(p, { force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * `tar -xzf`。PATH の tar が GNU tar (Git for Windows) だと `C:\...` の絶対パスを「ホスト C のリモート」と
 * 解釈して落ちる (実測: `Cannot connect to C: resolve failed`) ので、cwd を揃えて**相対パス**で渡す。
 */
function extractTarGz(archive: string, dir: string): Promise<void> {
  const cwd = path.dirname(archive);
  return new Promise((resolve, reject) => {
    execFile('tar', ['-xzf', path.basename(archive), '-C', path.relative(cwd, dir)], { cwd, windowsHide: true }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`tar の展開に失敗しました: ${stderr || err.message}`));
      else resolve();
    });
  });
}
