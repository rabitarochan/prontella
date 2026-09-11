import fs from 'node:fs';
import path from 'node:path';

/**
 * 言語 → 言語サーバーの対応表と、起動コマンドの解決 (純関数中心)。
 *
 * MVP は TypeScript / JavaScript のみ。多言語対応はここの表を増やすだけで載る形にしておく。
 */

export type LanguageId = 'typescript' | 'typescriptreact' | 'javascript' | 'javascriptreact';
export type ServerId = 'typescript';

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
};

export function languageIdFor(filePath: string): LanguageId | null {
  const name = filePath.split('/').pop() ?? filePath;
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  return EXT_TO_LANGUAGE[name.slice(dot).toLowerCase()] ?? null;
}

export function serverIdFor(languageId: LanguageId): ServerId {
  void languageId;
  return 'typescript';
}

// ---- 設定 ------------------------------------------------------------------

export type LspMode = 'builtin' | 'lsp';

export interface LspServerConfig {
  mode: LspMode;
  /** 明示指定の起動コマンド。`shell: true` では起動しないので実体のパスであること。 */
  command?: string;
  args?: string[];
}

export interface LspConfig {
  typescript: LspServerConfig;
}

export type LspConfigCheck = { ok: true; config: LspConfig } | { ok: false; error: string };

const DEFAULT_CONFIG: LspConfig = { typescript: { mode: 'builtin' } };

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
  const ts = (value as Record<string, unknown>).typescript;
  const out: LspServerConfig = { mode: 'builtin' };
  if (ts !== undefined && ts !== null) {
    if (typeof ts !== 'object' || Array.isArray(ts)) return { ok: false, error: 'lsp.typescript はオブジェクトが必要です' };
    const obj = ts as Record<string, unknown>;
    if (obj.mode !== undefined) {
      if (obj.mode !== 'builtin' && obj.mode !== 'lsp') return { ok: false, error: 'lsp.typescript.mode は "builtin" か "lsp" が必要です' };
      out.mode = obj.mode;
    }
    if (obj.command !== undefined) {
      if (typeof obj.command !== 'string' || obj.command.length === 0 || hasControlChar(obj.command)) {
        return { ok: false, error: 'lsp.typescript.command は空でも制御文字を含んでもいけません' };
      }
      out.command = obj.command;
    }
    if (obj.args !== undefined) {
      if (!Array.isArray(obj.args) || obj.args.some((a) => typeof a !== 'string' || hasControlChar(a))) {
        return { ok: false, error: 'lsp.typescript.args は文字列の配列が必要です' };
      }
      out.args = [...(obj.args as string[])];
    }
  }
  return { ok: true, config: { typescript: out } };
}

// ---- 起動コマンドの解決 -----------------------------------------------------

export interface Launch {
  command: string;
  args: string[];
  /** ステータス表示用の短い出自 */
  source: 'workspace-tsgo' | 'workspace-tls' | 'config' | 'path';
}

export interface ResolveEnv {
  root: string;
  config: LspServerConfig;
  /** terminalEnv() — PATH / PATHEXT を読む */
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  arch: string;
  execPath: string;
  exists: (abs: string) => boolean;
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
