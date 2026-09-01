import { execFileSync } from 'node:child_process';
import path from 'node:path';

/**
 * deck が起動する子プロセスへ渡す環境変数の構築点。ここ以外で `process.env` を
 * そのまま spawn に渡さない。
 *
 * 背景: bin/claude-deck.js は自分のために `process.env` へ PORT / NODE_ENV を書く。
 * さらに deck をどの端末から起動したかによって NO_COLOR・GIT_EDITOR・CLAUDECODE 等が
 * 紛れ込む。それらがそのまま PTY へ流れると、ターミナル内の `npm install` が
 * devDependencies を削除する (NODE_ENV=production)、dev サーバーが deck のポートを
 * 掴む (PORT=3711)、色が出ない (NO_COLOR) といった事故になる。
 *
 * 2 系統を使い分ける:
 *  - childEnv():    deck 内部ツール (git / ripgrep / ファイルマネージャー) 用。
 *                   deck 起動時に継承した env そのまま = 起動元の PATH を尊重する。
 *  - terminalEnv(): ユーザーのコードが走る経路 (PTY ターミナル / Agent SDK) 用。
 *                   「OS で新規に端末を開いた」状態を再構成した env。
 */

// bin/claude-deck.js が process.env を書き換える前のスナップショット。
let inherited: NodeJS.ProcessEnv | null = null;

/** bin/claude-deck.js から、process.env を書き換える前に一度だけ呼ぶ。 */
export function captureInheritedEnv(env: NodeJS.ProcessEnv = process.env): void {
  inherited = { ...env };
}

/**
 * capture 済みならそのスナップショット、未 capture なら process.env。
 * 未 capture になるのは `tsx watch server/index.ts` の開発起動 (bin を通らない) で、
 * その経路では誰も process.env を書き換えないため素のままで正しい。
 */
function inheritedEnv(): NodeJS.ProcessEnv {
  return inherited ?? process.env;
}

/** deck 内部ツール向け。継承した env + extra。 */
export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { ...inheritedEnv(), ...extra } as Record<string, string>;
}

// ---- Windows: レジストリーから「新規端末の環境」を再構成 ----------------------

/**
 * Machine/User レジストリーが定義しない、ログオンセッション由来の変数。
 * deny-list (レジストリーに無いものを全部引き継ぐ) にしないのは、それだと
 * 起動元シェルの汚染 (NO_COLOR / CLAUDECODE / GIT_EDITOR ...) がそのまま通るため。
 * Windows の環境変数名は大文字小文字を区別しないので、照合も無視して行う。
 */
const WINDOWS_SESSION_VARS = [
  'ALLUSERSPROFILE', 'APPDATA', 'CLIENTNAME', 'CommonProgramFiles', 'CommonProgramFiles(x86)',
  'CommonProgramW6432', 'COMPUTERNAME', 'ComSpec', 'DriverData', 'HOMEDRIVE', 'HOMEPATH',
  'LOCALAPPDATA', 'LOGONSERVER', 'NUMBER_OF_PROCESSORS', 'OS', 'PATHEXT',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432', 'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)',
  'ProgramW6432', 'PUBLIC', 'SESSIONNAME', 'SystemDrive', 'SystemRoot', 'TEMP', 'TMP',
  'USERDOMAIN', 'USERDOMAIN_ROAMINGPROFILE', 'USERNAME', 'USERPROFILE', 'windir',
];
const WINDOWS_SESSION_SET = new Set(WINDOWS_SESSION_VARS.map((n) => n.toUpperCase()));

/** 大文字小文字を無視して既存キーがあれば、その名前のまま値を差し替える。 */
function setCaseInsensitive(
  out: Record<string, string>,
  index: Map<string, string>,
  key: string,
  value: string,
): void {
  const upper = key.toUpperCase();
  const existing = index.get(upper);
  if (existing !== undefined) {
    out[existing] = value;
    return;
  }
  out[key] = value;
  index.set(upper, key);
}

function getCaseInsensitive(src: Record<string, string>, key: string): string | undefined {
  const upper = key.toUpperCase();
  for (const [k, v] of Object.entries(src)) {
    if (k.toUpperCase() === upper) return v;
  }
  return undefined;
}

/** Windows の環境変数名は大文字小文字を区別しないので、名前で引くときは無視する。 */
export function envGet(
  env: Record<string, string> | NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  return getCaseInsensitive(env as Record<string, string>, name);
}

/**
 * Windows で `exe` を PATH から探すときに試す絶対パスを、探索順に返す (純関数)。
 * 拡張子付きの名前ならそのまま試し、無ければ PATHEXT の各拡張子を順に付ける。
 *
 * 実ファイルの存在確認は呼び出し側の責務。ここを純関数にしてあるのは、
 * PATH の分解 (引用符・空要素・区切り) を単体テストで固定するため。
 */
export function windowsExecutableCandidates(
  exe: string,
  pathValue: string,
  pathExt: string,
): string[] {
  const dirs = pathValue
    .split(';')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => d.length > 0);
  // 既に拡張子が付いている名前に PATHEXT を足さない (pwsh.exe.EXE を作らない)
  const hasExt = /\.[^\\/.]+$/.test(exe);
  const exts = hasExt
    ? ['']
    : pathExt
        .split(';')
        .map((e) => e.trim())
        .filter((e) => e.length > 0);
  const out: string[] = [];
  for (const dir of dirs) {
    for (const ext of exts) out.push(path.join(dir, exe + ext));
  }
  return out;
}

/**
 * Windows が新しいプロセスの環境を作るときと同じ合成をする:
 * ログオンセッション変数 → Machine → User の順に重ね、PATH だけは
 * Machine + ';' + User の連結にする (実測: この連結文字列は実プロセスの
 * PATH に完全一致で含まれる)。
 */
export function composeWindowsEnv(src: {
  session: NodeJS.ProcessEnv;
  machine: Record<string, string>;
  user: Record<string, string>;
}): Record<string, string> {
  const out: Record<string, string> = {};
  const index = new Map<string, string>();

  for (const [k, v] of Object.entries(src.session)) {
    if (v === undefined) continue;
    if (WINDOWS_SESSION_SET.has(k.toUpperCase())) setCaseInsensitive(out, index, k, v);
  }
  for (const scope of [src.machine, src.user]) {
    for (const [k, v] of Object.entries(scope)) {
      if (v === undefined || v === null) continue;
      setCaseInsensitive(out, index, k, String(v));
    }
  }

  const machinePath = getCaseInsensitive(src.machine, 'PATH');
  const userPath = getCaseInsensitive(src.user, 'PATH');
  const merged = [machinePath, userPath]
    .map((p) => (p ?? '').replace(/;+$/, ''))
    .filter((p) => p.length > 0)
    .join(';');
  if (merged) setCaseInsensitive(out, index, 'PATH', merged);

  return out;
}

// Base64 で受け取るのは、コンソールのコードページに関係なく UTF-8 バイト列を
// そのまま運ぶため (日本語を含む環境変数値が化けない)。二重引用符を含めないので
// execFileSync の引数エスケープでも壊れない。
const WINDOWS_ENV_SCRIPT =
  "$m=[Environment]::GetEnvironmentVariables('Machine');" +
  "$u=[Environment]::GetEnvironmentVariables('User');" +
  '$j=@{machine=$m;user=$u}|ConvertTo-Json -Compress -Depth 4;' +
  '[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j))';

function buildWindowsTerminalEnv(): Record<string, string> {
  const stdout = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_ENV_SCRIPT],
    // 実測 (Windows 11 / PowerShell 5.1): 約 2 秒かかる。遅いマシンでも取りこぼさないよう
    // 余裕を持たせる。stdio 指定は powershell の stderr を deck のコンソールへ素通しさせないため。
    { timeout: 10_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const json = Buffer.from(stdout.toString('ascii').trim(), 'base64').toString('utf8');
  const parsed = JSON.parse(json) as { machine?: Record<string, string>; user?: Record<string, string> };
  return composeWindowsEnv({
    session: inheritedEnv(),
    machine: parsed.machine ?? {},
    user: parsed.user ?? {},
  });
}

// ---- POSIX: ログインシェルから「新規端末の環境」を再構成 ----------------------

/**
 * profile/rc では作れず、ログオンセッションから受け取るしかない変数。
 * ここに無いものはログインシェルが組み立て直す。
 */
const POSIX_SESSION_VARS = [
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TZ', 'TMPDIR', 'DISPLAY', 'WAYLAND_DISPLAY',
  'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'DBUS_SESSION_BUS_ADDRESS', 'SECURITYSESSIONID',
  'Apple_PubSub_Socket_Render', '__CF_USER_TEXT_ENCODING',
];
const POSIX_SESSION_PREFIXES = ['LC_', 'XDG_'];

function posixSessionEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(inheritedEnv())) {
    if (v === undefined) continue;
    if (POSIX_SESSION_VARS.includes(k) || POSIX_SESSION_PREFIXES.some((p) => k.startsWith(p))) {
      out[k] = v;
    }
  }
  return out;
}

/** `env -0` の出力 (NUL 区切りの "KEY=VALUE") を解析する。値に '=' や改行を含んでよい。 */
export function parseEnvNul(buf: Buffer | string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of buf.toString('utf8').split('\0')) {
    if (!entry) continue;
    const i = entry.indexOf('=');
    if (i <= 0) continue; // '=' で始まる要素や '=' の無い要素は捨てる
    out[entry.slice(0, i)] = entry.slice(i + 1);
  }
  return out;
}

function buildPosixTerminalEnv(): Record<string, string> {
  const session = posixSessionEnv();
  const shell = session.SHELL || '/bin/bash';
  // profile が最低限のコマンドを呼べるようブートストラップ PATH を渡す。
  // ログインシェルはこれを自分の PATH で置き換える。
  const stdout = execFileSync(shell, ['-l', '-c', 'env -0'], {
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...session, PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', TERM: 'xterm-256color' },
  });
  const parsed = parseEnvNul(stdout);
  if (!parsed.PATH) throw new Error('ログインシェルの環境に PATH がありません');
  // ログインシェルが引き継ぐだけで再構築しない変数 (SSH_AUTH_SOCK 等) を残す。
  return { ...session, ...parsed };
}

// ---- terminalEnv -----------------------------------------------------------

let terminalBase: Record<string, string> | null = null;
let warmed = false;

/**
 * fresh env を構築してキャッシュする。サーバー起動時に一度だけ呼ぶ。
 * PtyManager.create() が同期関数なので、非同期キャッシュにすると
 * 「起動直後の 1 本目だけフォールバック env」というレースが生まれる。
 * そのため同期ブロック (実測 約 2 秒 / Windows) を起動時に一度だけ払う。
 * 失敗しても継承 env で必ず動く (ターミナルが開けない事態を作らない)。
 */
export function warmTerminalEnv(): void {
  if (warmed) return;
  warmed = true;
  try {
    terminalBase = process.platform === 'win32' ? buildWindowsTerminalEnv() : buildPosixTerminalEnv();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[claude-deck3] OS 既定の環境変数を再構成できませんでした。deck が継承した環境で代用します: ${message}`,
    );
    terminalBase = null;
  }
}

/** ユーザーのコードが走る子プロセス (PTY / Agent SDK) 向け。fresh env + extra。 */
export function terminalEnv(extra: Record<string, string> = {}): Record<string, string> {
  if (!warmed) warmTerminalEnv();
  return { ...(terminalBase ?? inheritedEnv()), ...extra } as Record<string, string>;
}
