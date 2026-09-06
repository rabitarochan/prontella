// VS Code タイルのプロファイル (設定・拡張機能) を Prontella 側から管理する。
//
// **設定をどこに書くかが最大の勘所** (実測で確定):
//
//   ❌ <D>/data/User/settings.json は書いても効かない。
//      Web workbench のユーザー設定は**ブラウザーの IndexedDB** に入る
//      (vscode-web-db / vscode-userdata-store、キーは /User/settings.json)。
//      web.main.ts が vscode-userdata スキームを無条件に IndexedDB provider へ
//      登録しており、リモート接続の有無で分岐しない。VS Code 側は as-designed
//      (microsoft/vscode#202404)、サーバー保存の要望 #210775 は out-of-scope で
//      クローズ済み。つまりサーバーからは触れない。
//
//   ✅ <D>/data/Machine/settings.json (Remote Settings) は効く。
//      サーバー側の実ファイルで、優先順位が default < user < remote < workspace
//      なのでユーザー設定を上書きできる。RemoteUserConfiguration がファイルと
//      親ディレクトリーを watch していて、外部プロセスの書き換えを再読込する。
//
// 効かない設定がある (実測): ConfigurationScope.APPLICATION の設定は
// REMOTE_MACHINE_SCOPES に含まれないため Remote 設定では無視される。
// 例: security.workspace.trust.enabled は無視される一方、
//     workbench.colorTheme (WINDOW スコープ) は効く。
// キーバインドにはサーバー側の受け口が無い (keybindings.json はブラウザー側のみ)。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { terminalEnv } from './childEnv.js';

const execFileAsync = promisify(execFile);

/** 拡張機能 ID (`publisher.name`)。CLI 引数に載るので形を絞る。 */
const EXTENSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]*\.[A-Za-z0-9][A-Za-z0-9-]*$/;

export interface InstalledExtension {
  id: string;
  version: string | null;
}

export function machineSettingsPath(profileDir: string): string {
  return path.join(profileDir, 'data', 'Machine', 'settings.json');
}

/** Remote 設定を読む。未作成なら空オブジェクトの文字列を返す。 */
export function readMachineSettings(profileDir: string): string {
  try {
    return fs.readFileSync(machineSettingsPath(profileDir), 'utf8');
  } catch {
    return '{}\n';
  }
}

/**
 * Remote 設定を書く。
 *
 * VS Code の UI から Remote Settings を編集されると VS Code が全文を書き戻すため、
 * このファイルは Prontella の所有物として扱う (read-modify-write で他者編集を
 * 尊重しにいかない)。書く前に JSON として妥当かだけ確かめる — 壊れた JSON を
 * 置くと workbench 側が設定を丸ごと無視する。
 */
export function writeMachineSettings(profileDir: string, text: string): void {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('オブジェクトではありません');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`設定が JSON として不正です: ${message}`);
  }
  const file = machineSettingsPath(profileDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`);
}

/**
 * 導入済み拡張機能の一覧。
 *
 * VS Code が保守する `<D>/extensions/extensions.json` を読む。
 * CLI (`--list-extensions`) は 1 回あたり数秒かかるので使わない。
 *
 * **ディレクトリー名からは解析しない。** 命名は
 * `<publisher>.<name>-<version>[-<platform>]` だが、名前とバージョンの両方に
 * ハイフンが入りうるため境界を一意に決められない (実測:
 *   golang.go-0.56.1-universal                              → id が 1 ハイフン前
 *   ms-dotnettools.vscode-dotnet-runtime-3.1.0-universal    → 名前側に 2 個
 *   muhammad-sammy.csharp-2.145.21-g154a82fd27-win32-x64    → 版側にも 1 個
 * )。extensions.json は identifier.id と version を分けて持っている。
 */
export function listExtensions(profileDir: string): InstalledExtension[] {
  const file = path.join(profileDir, 'extensions', 'extensions.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // 未作成 (拡張機能ゼロ) か、書き換え中で壊れて見えた
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: InstalledExtension[] = [];
  for (const raw of parsed) {
    const e = raw as { identifier?: { id?: unknown }; version?: unknown };
    const id = e.identifier?.id;
    if (typeof id !== 'string' || !id) continue;
    out.push({ id, version: typeof e.version === 'string' ? e.version : null });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** CLI 引数に載せる前の検証。ここを通さない値をコマンドラインへ渡さない。 */
export function assertExtensionId(id: unknown): string {
  if (typeof id !== 'string' || !EXTENSION_ID_RE.test(id)) {
    throw new Error(`拡張機能 ID の形式が不正です: ${String(id)}`);
  }
  return id;
}

export interface ExtensionCliTarget {
  /** reh-web 同梱の node。 */
  node: string;
  /** out/server-main.js の絶対パス。 */
  main: string;
  /** 展開先 (cwd に使う)。 */
  dir: string;
  profileDir: string;
}

/**
 * 拡張機能を追加/削除する。
 *
 * サーバー実体は自前の CLI を持っていて、`--start-server` を付けなければ
 * CLI として実行して終了する (`--install-extension` / `--uninstall-extension`)。
 * `--extensions-dir` は既に `--server-data-dir` から導出されるので渡さない。
 *
 * ⚠ extensions.json はプロセス内キューでしか直列化されていない
 * (cross-process ロックが無い)。Prontella 自身の操作は下の queue で直列化するが、
 * **走行中のサーバーや VS Code の UI から同時に操作されると競合しうる**。
 */
export async function runExtensionCli(
  target: ExtensionCliTarget,
  args: string[],
): Promise<string> {
  const { stdout, stderr } = await execFileAsync(
    target.node,
    [target.main, '--server-data-dir', target.profileDir, ...args],
    {
      cwd: target.dir,
      env: terminalEnv(),
      windowsHide: true,
      timeout: 10 * 60_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  return `${stdout}${stderr}`.trim();
}

/** Prontella 側の拡張機能操作を直列化する (自分自身とは競合させない)。 */
let chain: Promise<unknown> = Promise.resolve();
export function serializeExtensionOp<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  // 失敗しても後続を止めない
  chain = next.catch(() => undefined);
  return next;
}
