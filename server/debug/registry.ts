import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

/**
 * デバッグアダプターの表・設定検証・起動コマンド解決・自動ダウンロード。server/lsp/registry.ts と同型
 * (一般化はしない)。`node` = vscode-js-debug (TCP)、`csharp` = netcoredbg (stdio)。
 */

export const ADAPTER_IDS = ['node', 'csharp'] as const;
export type AdapterId = (typeof ADAPTER_IDS)[number];

export function isAdapterId(v: unknown): v is AdapterId {
  return typeof v === 'string' && (ADAPTER_IDS as readonly string[]).includes(v);
}

/** 自動ダウンロードする版 (RESULTS.md の実測はこの版)。上げるときはスパイクを再測定する */
export const JS_DEBUG_VERSION = '1.140.0';
export const NETCOREDBG_VERSION = '3.2.0-1092';

export type Transport = 'tcp' | 'stdio';

interface AdapterSpec {
  /** `<toolsDir>/<dir>/<version>/` に展開する */
  dir: string;
  version: string;
  /** 展開先からの実体の相対パス */
  entry: string;
  transport: Transport;
  /** 配布物の URL (platform / arch で変わる。無い組み合わせは null = ダウンロード不可) */
  url: (platform: NodeJS.Platform, arch: string) => string | null;
  /** 展開後の後始末 (js-debug の package.json) */
  postExtract?: (dir: string) => void;
}

const EXE = process.platform === 'win32' ? '.exe' : '';

const ADAPTERS: Record<AdapterId, AdapterSpec> = {
  node: {
    dir: 'js-debug',
    version: JS_DEBUG_VERSION,
    entry: path.join('js-debug', 'src', 'dapDebugServer.js'),
    transport: 'tcp',
    url: () => `https://github.com/microsoft/vscode-js-debug/releases/download/v${JS_DEBUG_VERSION}/js-debug-dap-v${JS_DEBUG_VERSION}.tar.gz`,
    // tarball に package.json が無い。上位に "type":"module" の package.json があると ESM 扱いで即死する (RESULTS.md 前提)
    postExtract: (dir) => fs.writeFileSync(path.join(dir, 'js-debug', 'package.json'), '{"type":"commonjs"}\n'),
  },
  csharp: {
    dir: 'netcoredbg',
    version: NETCOREDBG_VERSION,
    entry: path.join('netcoredbg', 'netcoredbg' + EXE),
    transport: 'stdio',
    url: (platform, arch) => {
      const asset =
        platform === 'win32' && arch === 'x64' ? 'netcoredbg-win64.zip'
        : platform === 'linux' && arch === 'x64' ? 'netcoredbg-linux-amd64.tar.gz'
        : platform === 'linux' && arch === 'arm64' ? 'netcoredbg-linux-arm64.tar.gz'
        : platform === 'darwin' && arch === 'arm64' ? 'netcoredbg-osx-arm64.zip'
        : null;
      return asset && `https://github.com/Samsung/netcoredbg/releases/download/${NETCOREDBG_VERSION}/${asset}`;
    },
  },
};

export interface DebugAdapterConfig {
  /** node: 明示指定の `dapDebugServer.js` の絶対パス (node で起動する) */
  dapDebugServer?: string;
  /** csharp: 明示指定の `netcoredbg(.exe)` の絶対パス */
  netcoredbg?: string;
}
export type DebugConfig = Record<AdapterId, DebugAdapterConfig>;
export const DEFAULT_CONFIG: DebugConfig = { node: {}, csharp: {} };

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.codePointAt(i)!;
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

const CONFIG_KEYS: Record<AdapterId, keyof DebugAdapterConfig> = { node: 'dapDebugServer', csharp: 'netcoredbg' };

/** config.json トップレベル "debug" キーの検証 (checkLspConfig と同じ作法)。 */
export function checkDebugConfig(value: unknown): { ok: true; config: DebugConfig } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, config: structuredClone(DEFAULT_CONFIG) };
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'debug はオブジェクトが必要です (例: { "node": { "dapDebugServer": "..." } })' };
  const config = structuredClone(DEFAULT_CONFIG);
  for (const id of ADAPTER_IDS) {
    const v = (value as Record<string, unknown>)[id];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: `debug.${id} はオブジェクトが必要です` };
    const key = CONFIG_KEYS[id];
    const p = (v as Record<string, unknown>)[key];
    if (p !== undefined) {
      if (typeof p !== 'string' || p.length === 0 || hasControlChar(p)) return { ok: false, error: `debug.${id}.${key} は空でも制御文字を含んでもいけません` };
      config[id][key] = p;
    }
  }
  return { ok: true, config };
}

export interface Launch {
  command: string;
  args: string[];
  source: 'config' | 'tools' | 'vscode-ext' | 'path';
  transport: Transport;
}

export interface ResolveEnv {
  config: DebugAdapterConfig;
  execPath: string;
  home: string;
  /** `~/.prontella/tools` */
  toolsDir: string;
  /** terminalEnv() の PATH (csharp の `netcoredbg` を探す) */
  envPath?: string;
  platform?: NodeJS.Platform;
  exists: (abs: string) => boolean;
  listDir: (abs: string) => string[];
}

/** ダウンロード先の実体パス */
export function toolsEntry(toolsDir: string, id: AdapterId): string {
  const spec = ADAPTERS[id];
  return path.join(toolsDir, spec.dir, spec.version, spec.entry);
}

/**
 * 解決順: 1. config の明示指定 2. `~/.prontella/tools/<dir>/<ver>/` 3. node は VS Code 拡張 `ms-vscode.js-debug-*`
 * (新しい版から。ponytail: 文字列降順)、csharp は PATH の `netcoredbg` 4. null (= 呼び出し側がダウンロードして 2 を作る)。
 * `.js` は必ず prontella と同じ node (execPath) で起動する — `.cmd` シム問題も PATH 依存も無い
 */
export function resolveAdapter(r: ResolveEnv, id: AdapterId): Launch | null {
  if (id === 'csharp') {
    const args = ['--interpreter=vscode'];
    if (r.config.netcoredbg) return { command: r.config.netcoredbg, args, source: 'config', transport: 'stdio' };
    const tools = toolsEntry(r.toolsDir, 'csharp');
    if (r.exists(tools)) return { command: tools, args, source: 'tools', transport: 'stdio' };
    const sep = (r.platform ?? process.platform) === 'win32' ? ';' : ':';
    for (const dir of (r.envPath ?? '').split(sep).map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)) {
      const candidate = path.join(dir, 'netcoredbg' + EXE);
      if (r.exists(candidate)) return { command: candidate, args, source: 'path', transport: 'stdio' };
    }
    return null;
  }
  if (r.config.dapDebugServer) return { command: r.execPath, args: [r.config.dapDebugServer], source: 'config', transport: 'tcp' };
  const tools = toolsEntry(r.toolsDir, 'node');
  if (r.exists(tools)) return { command: r.execPath, args: [tools], source: 'tools', transport: 'tcp' };
  const extDir = path.join(r.home, '.vscode', 'extensions');
  for (const name of r.listDir(extDir).filter((n) => n.startsWith('ms-vscode.js-debug-')).sort().reverse()) {
    const candidate = path.join(extDir, name, 'src', 'dapDebugServer.js');
    if (r.exists(candidate)) return { command: r.execPath, args: [candidate], source: 'vscode-ext', transport: 'tcp' };
  }
  return null;
}

export interface DownloadDeps {
  toolsDir: string;
  fetch?: typeof fetch;
  /** アーカイブを dir に展開する。既定は bsdtar (`-xf` が tar.gz も zip も読む) */
  extract?: (archive: string, dir: string) => Promise<void>;
  platform?: NodeJS.Platform;
  arch?: string;
}

const inflight = new Map<AdapterId, Promise<string>>();

/**
 * アダプターの配布物を `<toolsDir>/<dir>/<ver>/` に置く。戻り値は実体の絶対パス。
 * 途中失敗の残骸 (`.part` / `.tmp`) を「完成」と誤認しないよう、完成形は最後の rename でだけ現れる。
 * 同時に 2 セッションが始まっても 1 回しか落とさない (single-flight、アダプターごと)。
 * ponytail: チェックサム検証は無し (版を固定 + HTTPS)。必要なら release の SHA を版の隣に置く。
 */
export function downloadAdapter(id: AdapterId, deps: DownloadDeps): Promise<string> {
  const cur = inflight.get(id);
  if (cur) return cur;
  const p = doDownload(id, deps).finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

async function doDownload(id: AdapterId, deps: DownloadDeps): Promise<string> {
  const spec = ADAPTERS[id];
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const url = spec.url(platform, arch);
  if (!url) throw new Error(`${spec.dir} は ${platform}/${arch} 向けの配布物がありません。手動で配置して config.json に指定してください`);
  const base = path.join(deps.toolsDir, spec.dir);
  const dest = path.join(base, spec.version);
  const entry = path.join(dest, spec.entry);
  if (fs.existsSync(entry)) return entry;
  fs.mkdirSync(base, { recursive: true });
  const archive = path.join(base, `${spec.version}${url.endsWith('.zip') ? '.zip' : '.tar.gz'}`);
  const part = `${archive}.part`;
  const tmp = `${dest}.tmp`;
  const f = deps.fetch ?? fetch;
  try {
    const res = await f(url);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), fs.createWriteStream(part));
    fs.renameSync(part, archive);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    await (deps.extract ?? extractArchive)(archive, tmp);
    if (!fs.existsSync(path.join(tmp, spec.entry))) throw new Error(`展開後に ${spec.entry} が見つかりません`);
    spec.postExtract?.(tmp);
    fs.renameSync(tmp, dest);
    return entry;
  } finally {
    for (const p of [part, archive]) fs.rmSync(p, { force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * bsdtar の `-xf` (tar.gz も zip も自動判別)。Windows は `System32\tar.exe` を明示する — PATH の tar が GNU tar
 * (Git for Windows) だと zip を読めず、`C:\...` の絶対パスを「ホスト C のリモート」と解釈して落ちる
 * (実測: `Cannot connect to C: resolve failed`)。念のため cwd を揃えて**相対パス**で渡す。`Expand-Archive` は
 * モジュールが読めない機体があるので使わない (RESULTS.md C#)。
 */
function extractArchive(archive: string, dir: string): Promise<void> {
  const cwd = path.dirname(archive);
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  return new Promise((resolve, reject) => {
    execFile(tar, ['-xf', path.basename(archive), '-C', path.relative(cwd, dir)], { cwd, windowsHide: true }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`アーカイブの展開に失敗しました: ${stderr || err.message}`));
      else resolve();
    });
  });
}
