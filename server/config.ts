import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyFlags, normalizeRepoConfig, reconcileOrder } from './repoOrder.js';

export interface RepoConfig {
  id: string;
  path: string;
  name: string;
  pinned?: boolean;
  archived?: boolean;
  [key: string]: unknown; // repoOrder.ts の normalizeRepoConfig が未知キーを spread で保持するため
}

interface DeckConfig {
  repos: RepoConfig[];
  [key: string]: unknown; // トップレベルの未知キーも loadConfig→saveConfig で往復させる
}

/** 改名前 (Claude Deck 3) の設定ディレクトリー名。移行のためだけに参照する。 */
const LEGACY_DIR_NAME = '.claude-deck3';

/**
 * 設定ディレクトリーを解決し、必要なら旧名から 1 回だけ移行する。
 *
 * 「新が無く、旧がある」ときだけ rename する。rename に失敗したとき (他プロセスが
 * ファイルを開いている等) は**旧ディレクトリーを使い続ける** — 新規作成に倒すと、
 * 登録リポジトリー一覧と resume 用セッションが消えたように見えるため。
 * 本体は agent-sessions/ を含むディレクトリーごと移すので、hooks.ts や
 * agentSession.ts も自前で homedir() を組み立てず、この CONFIG_DIR を使うこと。
 */
function resolveConfigDir(): string {
  const home = os.homedir();
  const next = path.join(home, '.prontella');
  const legacy = path.join(home, LEGACY_DIR_NAME);
  if (fs.existsSync(next) || !fs.existsSync(legacy)) return next;
  try {
    fs.renameSync(legacy, next);
    console.log(`[prontella] 設定ディレクトリーを ${legacy} から ${next} へ移行しました。`);
    return next;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[prontella] 設定ディレクトリーの移行に失敗したため ${legacy} を使い続けます: ${message}`,
    );
    return legacy;
  }
}

export const CONFIG_DIR = resolveConfigDir();
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export function repoId(repoPath: string): string {
  return Buffer.from(path.resolve(repoPath)).toString('base64url');
}

/**
 * 一時ファイル(`<file>.tmp`、同一ディレクトリー固定名)に書いてから rename で置換する原子的書き込み。
 * 実測(Windows 11 / Node v24): renameSync は既存ファイルを上書きできるが、リネーム先が他プロセスに
 * 開かれていると EPERM(読み取り専用オープンでも)。そのため EPERM/EBUSY/EACCES は短い間隔で
 * 3 回までリトライしてから諦める。一時ファイルの残骸は finally で必ず掃除する。
 */
export function writeJsonAtomic(file: string, data: unknown): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmpFile = `${file}.tmp`;
  const json = JSON.stringify(data, null, 2);
  try {
    writeWithRetry(tmpFile, file, json);
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // 正常時は既に rename 済みで存在しない。失敗時のみ実際に掃除される。
    }
  }
}

const MAX_RETRIES = 3;

function writeWithRetry(tmpFile: string, file: string, json: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.writeFileSync(tmpFile, json, 'utf8');
      fs.renameSync(tmpFile, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retryable = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
      if (!retryable || attempt >= MAX_RETRIES) throw err;
      sleepSyncMs(30 * (attempt + 1));
    }
  }
}

/** Node は main thread でも Atomics.wait を許可する(ブラウザーと異なる)。async/await を使わずに
 * 短時間ブロックするための同期スリープ。 */
function sleepSyncMs(ms: number): void {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

// このプロセスで config.json の破損退避を一度でも行ったかどうか。値は退避先の絶対パス
// (未発生なら null)。退避後は CONFIG_FILE が存在しなくなり次回以降 ENOENT 分岐に落ちるため、
// このフラグが無いと「1 回だけ 500、以後は新規インストールと区別のつかない空サイドバー」に
// 静かに戻ってしまう(D1 の「500 を吐き続ける(沈黙より良い)」という意図が壊れる)。
// フラグを立てた以降はこのプロセスの loadConfig は ENOENT かどうかによらず投げ続ける。
// 復旧手段はサーバー再起動(= このフラグのリセット)にする。
let corruptedThisProcess: string | null = null;

/**
 * 失敗時の扱いを 3 分岐にする(全書き込み経路が load→変更→save のため、ここで安易に
 * `{ repos: [] }` を返すと「読めない config を空で確定させる」データ喪失経路になる):
 * - ENOENT(初回起動)→ `{ repos: [] }`
 * - 読み取りエラー(ENOENT 以外)→ 退避せず rethrow
 * - JSON.parse 失敗のみ → `config.json.corrupt-<タイムスタンプ>` にリネームして退避した上で rethrow
 *   (退避自体の失敗は元の例外を優先し、握りつぶさない)。退避に成功したら console.error で
 *   退避先の絶対パスと復旧方法(サーバー再起動)を出し、以後このプロセスの loadConfig は
 *   ずっと投げ続ける(corruptedThisProcess 参照)。
 */
export function loadConfig(): DeckConfig {
  if (corruptedThisProcess) {
    throw new Error(
      `config.json は破損していたため ${corruptedThisProcess} に退避済みです。内容を確認・修復して ` +
      `${CONFIG_FILE} に戻したうえで、サーバーを再起動してください。`,
    );
  }

  let raw: string;
  try {
    raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { repos: [] };
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (parseErr) {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const corruptFile = `${CONFIG_FILE}.corrupt-${stamp}`;
      fs.renameSync(CONFIG_FILE, corruptFile);
      corruptedThisProcess = corruptFile;
      console.error(
        `[prontella] config.json の解析に失敗したため ${corruptFile} に退避しました。` +
        `内容を確認・修復して ${CONFIG_FILE} に戻したうえで、サーバーを再起動してください。` +
        `このプロセスは復旧まで config の読み書きができません。`,
      );
    } catch {
      // 退避に失敗しても元の parseErr を優先して投げる(例外を差し替えない)。
      // この場合 corruptedThisProcess は立てない(退避できていないため次回も ENOENT にならず
      // 同じ読み取り/パースを再試行できる)。
    }
    throw parseErr;
  }

  // トップレベルの未知キーも保持する。parsed が非 null オブジェクト(配列は除く)のときのみ
  // spread する(null/文字列/配列を spread すると壊れる、または意図しない結果になるため)。
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    return { ...obj, repos: normalizeRepoConfig(obj.repos) };
  }
  return { repos: normalizeRepoConfig(undefined) };
}

// 注意: loadConfig() から saveConfig() までの間に await を絶対に置かないこと。この関数群の
// read-modify-write の原子性は Node のシングルスレッド実行順序だけが担保している
// (途中で他リクエストの読み込み/書き込みが割り込むと更新が失われる)。
export function saveConfig(config: DeckConfig): void {
  writeJsonAtomic(CONFIG_FILE, config);
}

export function addRepo(repoPath: string): RepoConfig {
  const resolved = path.resolve(repoPath);
  let stat: fs.Stats;
  try { stat = fs.statSync(resolved); }
  catch { throw new Error(`ディレクトリーが存在しません: ${resolved}`); }
  if (!stat.isDirectory()) throw new Error(`ディレクトリーではありません: ${resolved}`);
  const config = loadConfig();
  const id = repoId(resolved);
  const existing = config.repos.find((r) => r.id === id);
  if (existing) return existing;
  const repo: RepoConfig = { id, path: resolved, name: path.basename(resolved) };
  config.repos.push(repo);
  saveConfig(config);
  return repo;
}

export function removeRepo(id: string): void {
  const config = loadConfig();
  config.repos = config.repos.filter((r) => r.id !== id);
  saveConfig(config);
}

export function getRepo(id: string): RepoConfig | undefined {
  return loadConfig().repos.find((r) => r.id === id);
}

/** PATCH /api/repos/:id 用。検証・相互排他の強制は repoOrder.ts の applyFlags に委譲する。 */
export function setRepoFlags(
  id: string,
  flags: { pinned?: unknown; archived?: unknown },
): { ok: true; repos: RepoConfig[] } | { ok: false; error: string } {
  const config = loadConfig();
  const result = applyFlags(config.repos, id, flags);
  if (!result.ok) return result;
  // トップレベルの未知キーを落とさないよう config を spread する({ repos: ... } だけを
  // 新規に作ると loadConfig が保持したトップレベルキーがここで消える)。
  saveConfig({ ...config, repos: result.repos });
  return result;
}

/** PUT /api/repos/order 用。突合ロジックは repoOrder.ts の reconcileOrder に委譲する。 */
export function reorderRepos(
  order: unknown,
): { ok: true; repos: RepoConfig[] } | { ok: false; error: string } {
  const config = loadConfig();
  const result = reconcileOrder(config.repos, order);
  if (!result.ok) return result;
  saveConfig({ ...config, repos: result.repos });
  return result;
}
