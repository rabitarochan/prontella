import fs from 'node:fs';
import path from 'node:path';

/**
 * 言語 → 言語サーバーの対応表と、起動コマンドの解決 (純関数中心)。
 *
 * MVP は TypeScript / JavaScript のみ。多言語対応はここの表を増やすだけで載る形にしておく。
 */

export type LanguageId = 'typescript' | 'typescriptreact' | 'javascript' | 'javascriptreact' | 'csharp';
export const SERVER_IDS = ['typescript', 'csharp'] as const;
export type ServerId = (typeof SERVER_IDS)[number];
export function isServerId(v: unknown): v is ServerId {
  return typeof v === 'string' && (SERVER_IDS as readonly string[]).includes(v);
}

// `.tsx` は必ず typescriptreact で開く。tsgo は**最初の didOpen の languageId をそのファイルの
// スクリプト種別として固定する**ので、typescript で開くと JSX が型アサーションとして解釈され
// 数百件の構文エラーになり、開き直しても直らない (scripts/lsp-spike/RESULTS.md S4)。
const EXT_TO_LANGUAGE: Readonly<Record<string, LanguageId>> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascriptreact',
  // .csx / .cake は Roslyn LS の対象外なので入れない
  '.cs': 'csharp',
};

export function languageIdFor(filePath: string): LanguageId | null {
  const name = filePath.split('/').pop() ?? filePath;
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  return EXT_TO_LANGUAGE[name.slice(dot).toLowerCase()] ?? null;
}

export function serverIdFor(languageId: LanguageId): ServerId {
  return languageId === 'csharp' ? 'csharp' : 'typescript';
}

// ---- 設定 ------------------------------------------------------------------

export type LspMode = 'builtin' | 'lsp' | 'off';
/** サーバーごとの mode の値域。TS は内蔵 worker が代替になる。C# には内蔵が無いので on/off */
export const MODES_BY_SERVER: Readonly<Record<ServerId, readonly LspMode[]>> = {
  typescript: ['builtin', 'lsp'],
  csharp: ['lsp', 'off'],
};

export interface LspServerConfig {
  mode: LspMode;
  /** 明示指定の起動コマンド。`shell: true` では起動しないので実体のパスであること。 */
  command?: string;
  args?: string[];
}

export type LspConfig = Record<ServerId, LspServerConfig>;

export type LspConfigCheck = { ok: true; config: LspConfig } | { ok: false; error: string };

/** C# は検出できれば有効 (未検出は `disabled` 表示で済み、ダイアログは出ない)。TS は既存挙動の builtin */
export const DEFAULT_CONFIG: LspConfig = { typescript: { mode: 'builtin' }, csharp: { mode: 'lsp' } };

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.codePointAt(i)!;
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/**
 * config.json トップレベル "lsp" キーの検証。vnc.ts の checkVncConfig と同じ作法:
 * typeof object / Array.isArray を先に弾き、文字列は制御文字を拒否し、型ごとに範囲を見る。
 */
export function checkLspConfig(value: unknown): LspConfigCheck {
  if (value === undefined || value === null) return { ok: true, config: structuredClone(DEFAULT_CONFIG) };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'lsp はオブジェクトが必要です (例: { "typescript": { "mode": "lsp" } })' };
  }
  const config = structuredClone(DEFAULT_CONFIG);
  for (const id of SERVER_IDS) {
    const r = checkServer(id, (value as Record<string, unknown>)[id], config[id]);
    if (!r.ok) return r;
    config[id] = r.config;
  }
  return { ok: true, config };
}

function checkServer(id: ServerId, value: unknown, out: LspServerConfig): { ok: true; config: LspServerConfig } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, config: out };
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: `lsp.${id} はオブジェクトが必要です` };
  const obj = value as Record<string, unknown>;
  const modes = MODES_BY_SERVER[id];
  if (obj.mode !== undefined) {
    if (typeof obj.mode !== 'string' || !(modes as readonly string[]).includes(obj.mode)) {
      return { ok: false, error: `lsp.${id}.mode は ${modes.map((m) => `"${m}"`).join(' か ')} が必要です` };
    }
    out.mode = obj.mode as LspMode;
  }
  if (obj.command !== undefined) {
    if (typeof obj.command !== 'string' || obj.command.length === 0 || hasControlChar(obj.command)) {
      return { ok: false, error: `lsp.${id}.command は空でも制御文字を含んでもいけません` };
    }
    out.command = obj.command;
  }
  if (obj.args !== undefined) {
    if (!Array.isArray(obj.args) || obj.args.some((a) => typeof a !== 'string' || hasControlChar(a))) {
      return { ok: false, error: `lsp.${id}.args は文字列の配列が必要です` };
    }
    out.args = [...(obj.args as string[])];
  }
  return { ok: true, config: out };
}

// ---- 起動コマンドの解決 -----------------------------------------------------

export interface Launch {
  command: string;
  args: string[];
  /** ステータス表示用の短い出自 */
  source: 'workspace-tsgo' | 'workspace-tls' | 'config' | 'path' | 'vscode-ext' | 'dotnet-tool';
  /** 起動前に作っておくログディレクトリー (Roslyn の --extensionLogDirectory) */
  logDir?: string;
}

export interface ResolveEnv {
  root: string;
  serverId: ServerId;
  config: LspServerConfig;
  /** terminalEnv() — PATH / PATHEXT を読む */
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  arch: string;
  execPath: string;
  /** os.homedir() — VS Code 拡張 / dotnet tool の配置を探す */
  home: string;
  tmpDir: string;
  pid: number;
  exists: (abs: string) => boolean;
  listDir: (abs: string) => string[];
}

/**
 * 解決順:
 *   1. ワークスペースの TypeScript ≥ 7 (Go 製) の内蔵 LSP: `@typescript/typescript-<platform>-<arch>/lib/tsc --lsp --stdio`
 *      (実体パスの規則は typescript/lib/getExePath.js と同じ)。ワークスペースの TS と必ず一致する
 *   2. ワークスペースの typescript-language-server + TS 5 系 (`typescript/lib/tsserver.js` があるとき)。
 *      TS 7 には tsserver.js が無く initialize で落ちるため、tsserver.js の存在を条件にする
 *   3. config.json の明示指定
 *   4. PATH 上の typescript-language-server (npm global の配置: `<dir>/node_modules/.../cli.mjs`)。
 *      `.cmd` シムは shell 無しで起動できないので実体の cli.mjs を process.execPath で叩く
 *   5. null (= disabled。無い環境が普通なのでエラーにしない)
 */
export function resolveLaunch(r: ResolveEnv): Launch | null {
  if (r.serverId === 'csharp') return resolveCsharp(r);
  const nm = path.join(r.root, 'node_modules');
  const tsgo = tsgoExe(nm, r.platform, r.arch);
  if (r.exists(path.join(nm, 'typescript', 'lib', 'getExePath.js')) && r.exists(tsgo)) {
    return { command: tsgo, args: ['--lsp', '--stdio'], source: 'workspace-tsgo' };
  }
  const cli = path.join(nm, 'typescript-language-server', 'lib', 'cli.mjs');
  if (r.exists(cli) && r.exists(path.join(nm, 'typescript', 'lib', 'tsserver.js'))) {
    return { command: r.execPath, args: [cli, '--stdio'], source: 'workspace-tls' };
  }
  if (r.config.command) {
    return { command: r.config.command, args: r.config.args ?? ['--stdio'], source: 'config' };
  }
  const sep = r.platform === 'win32' ? ';' : ':';
  for (const dir of (r.env.PATH ?? '').split(sep).map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)) {
    for (const candidate of [
      path.join(dir, 'node_modules', 'typescript-language-server', 'lib', 'cli.mjs'),
      path.join(dir, '..', 'lib', 'node_modules', 'typescript-language-server', 'lib', 'cli.mjs'),
    ]) {
      if (r.exists(candidate)) return { command: r.execPath, args: [candidate, '--stdio'], source: 'path' };
    }
  }
  return null;
}

/**
 * C# (公式 Roslyn LS = Microsoft.CodeAnalysis.LanguageServer) の解決順:
 *   1. config.json の明示指定 (args 省略時は Roslyn の既定引数)
 *   2. VS Code C# 拡張の同梱物 `~/.vscode/extensions/ms-dotnettools.csharp-<ver>-<os>/.roslyn/` (新しい版から)
 *   3. PATH 上の `roslyn-language-server` (dotnet tool。`.exe` は実体なので shell 無しで起動できる)
 *   4. `~/.dotnet/tools/roslyn-language-server`
 *   5. null
 * 既定引数: --stdio、ログ先 (無いと起動しない)、--clientProcessId (prontella が死んだら LS も終わる。
 * Windows は孤児を殺さない)。--autoLoadProjects は使わない — root 配下の全プロジェクト (worktree の
 * 複製まで) を読んで 118 秒 / 900MB になる (RESULTS.md R2)。代わりにセッションが最寄りの .sln を
 * `solution/open` する (25 秒 / ~450MB。R3)。
 */
function resolveCsharp(r: ResolveEnv): Launch | null {
  const logDir = path.join(r.tmpDir, 'prontella-roslyn');
  const args = ['--stdio', '--logLevel', 'Information', '--extensionLogDirectory', logDir, '--clientProcessId', String(r.pid)];
  const exe = r.platform === 'win32' ? '.exe' : '';
  if (r.config.command) return { command: r.config.command, args: r.config.args ?? args, source: 'config', logDir };
  const extDir = path.join(r.home, '.vscode', 'extensions');
  // ponytail: 文字列降順で「最新」を選ぶ。2.9 → 2.10 の桁繰り上がりを正しく扱うには semver 比較が要る
  for (const name of r.listDir(extDir).filter((n) => n.startsWith('ms-dotnettools.csharp-')).sort().reverse()) {
    const candidate = path.join(extDir, name, '.roslyn', 'Microsoft.CodeAnalysis.LanguageServer' + exe);
    if (r.exists(candidate)) return { command: candidate, args, source: 'vscode-ext', logDir };
  }
  const sep = r.platform === 'win32' ? ';' : ':';
  for (const dir of (r.env.PATH ?? '').split(sep).map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)) {
    const candidate = path.join(dir, 'roslyn-language-server' + exe);
    if (r.exists(candidate)) return { command: candidate, args, source: 'path', logDir };
  }
  const tool = path.join(r.home, '.dotnet', 'tools', 'roslyn-language-server' + exe);
  if (r.exists(tool)) return { command: tool, args, source: 'dotnet-tool', logDir };
  return null;
}

/**
 * ファイルに最も近いソリューション (ファイルのディレクトリーから root まで遡って最初に見つかる
 * `*.sln` / `*.slnx`)。同じディレクトリーに複数あれば名前順の先頭。無ければ null (misc 扱い)。
 * Roslyn LS は 1 プロセス 1 ソリューションなので、これがプロセスの単位になる。
 */
export function findSolution(root: string, absFile: string, listDir: (abs: string) => string[]): string | null {
  const rootAbs = path.resolve(root);
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  let dir = path.dirname(path.resolve(absFile));
  for (;;) {
    const slns = listDir(dir)
      .filter((n) => /\.slnx?$/i.test(n))
      .sort();
    if (slns.length > 0) return path.join(dir, slns[0]!);
    if (norm(dir) === norm(rootAbs)) return null;
    const parent = path.dirname(dir);
    if (parent === dir || !norm(dir).startsWith(norm(rootAbs))) return null;
    dir = parent;
  }
}

export function fsListDir(abs: string): string[] {
  try {
    return fs.readdirSync(abs);
  } catch {
    return [];
  }
}

function tsgoExe(nm: string, platform: NodeJS.Platform, arch: string): string {
  const exe = platform === 'win32' ? 'tsc.exe' : 'tsc';
  return path.join(nm, '@typescript', `typescript-${platform}-${arch}`, 'lib', exe);
}

export function fsExists(abs: string): boolean {
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}
