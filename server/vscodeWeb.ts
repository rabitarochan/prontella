// VSCodium reh-web (Web Host) をタイル用のバックエンドとして常駐させる。
//
// 設計の要点 (すべてスパイクの実測にもとづく — 詳細は plan の「スパイク結果」):
//
// - 起動は bin/codium-server.cmd ではなく `<dir>/node.exe out/server-main.js` を直接叩く。
//   .cmd は同じコマンドを組み立てるだけの薄いラッパーで、cmd.exe を挟むと引数の
//   クォート事故を招く。アーカイブは node.exe を同梱しているのでユーザーの Node には依存しない。
// - --server-data-dir は必ず明示する。省略すると ~/.vscodium-server にフォールバックし、
//   ユーザーの他のインスタンスと相乗りしてしまう。
// - env は childEnv() ではなく terminalEnv()。拡張機能とデバッガーが dotnet / go / cargo を
//   PATH から見つけられる必要があるため、ここは決定的。
// - プロセスは 1 本だけ持つ。開くフォルダーは ?folder= クエリで決まるので、
//   リポジトリーごとにプロセスを立てる理由がない (立てると拡張機能も入れ直しになる)。
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { terminalEnv } from './childEnv.js';
import { CONFIG_DIR } from './config.js';
import { installVsCodium, type InstallProgress } from './vscodeDownload.js';

/** プロキシの前置パス。サーバーへ渡す --server-base-path と必ず一致させること。 */
export const VSCODE_BASE_PATH = '/vscode';

const VSCODE_DIR = path.join(CONFIG_DIR, 'vscode');
/** 拡張機能・Machine 設定・ワークスペース保存はここに貯まる (デスクトップ版とは完全に別系統)。 */
const PROFILE_DIR = path.join(VSCODE_DIR, 'profile');
/** プロファイル管理 (設定・拡張機能) 側から参照する。 */
export const VSCODE_PROFILE_DIR = PROFILE_DIR;
/** ダウンロード済み reh-web の展開先。バージョンごとのディレクトリーを並べる。 */
const INSTALL_ROOT = path.join(VSCODE_DIR, 'vscodium');

/**
 * 直近に起動したサーバーの pid。
 * Windows では親を強制終了 (TerminateProcess / タスクマネージャー) されると
 * SIGTERM ハンドラーが走らず、重い VS Code サーバーが孤児として残る。
 * ポートは --port 0 なので衝突はしないが、次回起動のたびに 1 本ずつ
 * 積み上がってメモリーを食う。起動時にここを見て前回の残骸を始末する。
 */
const PID_FILE = path.join(VSCODE_DIR, 'server.pid');

/** 実測の起動ログ: `Extension host agent listening on 8000` */
const PORT_RE = /Extension host agent listening on (\d+)/;
const START_TIMEOUT_MS = 60_000;
/** 異常終了の診断用に stderr を末尾だけ保持する。 */
const ERR_TAIL_LIMIT = 2000;

/** タイル自体の出し分けフラグ。既定では機能ごと存在しない (plan のライセンス判断による)。 */
export function vscodeTileEnabled(): boolean {
  return process.env.PRONTELLA_VSCODE_TILE === '1';
}

export interface VsCodeStatus {
  /** 実行ファイルが解決できたか (未導入なら false) */
  installed: boolean;
  installDir: string | null;
  running: boolean;
  /** workbench が応答可能 (ポートが取れた) */
  ready: boolean;
  /** 準備中 (ダウンロード・展開・起動のいずれか)。ready になるまでクライアントは status を追う。 */
  preparing: boolean;
  /** ダウンロード/展開の進捗。準備中でなければ null。 */
  install: InstallProgress | null;
  basePath: string;
  lastError: string | null;
}

interface Install {
  dir: string;
  node: string;
  main: string;
}

/**
 * reh-web の展開先を解決する。
 * - PRONTELLA_VSCODE_DIR があればそれを最優先 (開発・検証用の逃げ道)
 * - なければ <CONFIG_DIR>/vscode/vscodium/<ver>/ のうち最も新しいもの
 * 自動ダウンロードは段階 3。ここでは「あるものを見つける」だけに徹する。
 */
function resolveInstall(): Install | null {
  const candidates: string[] = [];
  const override = process.env.PRONTELLA_VSCODE_DIR;
  if (override) candidates.push(override);
  if (fs.existsSync(INSTALL_ROOT)) {
    const versions = fs
      .readdirSync(INSTALL_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(INSTALL_ROOT, e.name))
      // 名前順の降順。バージョン文字列は 1.126.04524 形式で桁が揃っているため辞書順で足りる
      .sort((a, b) => b.localeCompare(a));
    candidates.push(...versions);
  }
  for (const dir of candidates) {
    const node = path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
    const main = path.join(dir, 'out', 'server-main.js');
    if (fs.existsSync(node) && fs.existsSync(main)) return { dir, node, main };
  }
  return null;
}

/**
 * pid が「本当に前回の VS Code サーバーか」を確認する。
 *
 * **pid は再利用される。** pidfile が残るのは親が強制終了された後だけで、
 * そのとき当該 pid が無関係のプロセスに割り当たっている可能性がある。
 * 存在確認 (signal 0) だけで殺すと、それを巻き込む。
 * コマンドラインに自分の PROFILE_DIR が入っていることまで確認する —
 * このパスを引数に持つプロセスは、定義上こちらが起動したものしかない。
 */
function isOurServer(pid: number): boolean {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
        ],
        { encoding: 'utf8', timeout: 10_000, windowsHide: true },
      );
      return out.includes(PROFILE_DIR);
    }
    const out = execFileSync('ps', ['-o', 'args=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    return out.includes(PROFILE_DIR);
  } catch {
    // 照会できなければ「自分のものだと確認できなかった」として殺さない
    return false;
  }
}

/** 前回起動の残骸 (親の強制終了で残った孤児) を始末する。 */
function killStaleServer(): void {
  let pid: number;
  try {
    pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
  } catch {
    return; // pidfile が無いのは正常 (初回起動 / 前回は正常終了)
  }
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  try {
    process.kill(pid, 0); // 存在確認のみ
  } catch {
    return; // すでに死んでいる
  }
  if (!isOurServer(pid)) return;
  try {
    process.kill(pid);
    console.log(`[prontella] 前回の VS Code サーバー (pid ${pid}) を終了しました`);
  } catch {
    // 権限が無い等。放置しても --port 0 なので衝突はしない
  }
}

class VsCodeWebServer {
  private proc: ChildProcess | null = null;
  private port: number | null = null;
  private install: Install | null = null;
  private inflight: Promise<number> | null = null;
  private lastError: string | null = null;
  private errTail = '';
  private installProgress: InstallProgress | null = null;

  /** プロキシが転送先を知るための唯一の入口。未起動なら null。 */
  activePort(): number | null {
    return this.port;
  }

  /**
   * 拡張機能 CLI を叩くための実行ファイル情報。未導入なら null。
   * 起動していなくても、導入さえされていれば CLI は使える。
   */
  cliTarget(): { node: string; main: string; dir: string; profileDir: string } | null {
    const install = this.install ?? resolveInstall();
    if (!install) return null;
    return { node: install.node, main: install.main, dir: install.dir, profileDir: PROFILE_DIR };
  }

  status(): VsCodeStatus {
    const install = this.install ?? resolveInstall();
    return {
      installed: install !== null,
      installDir: install?.dir ?? null,
      running: this.proc !== null,
      ready: this.port !== null,
      preparing: this.inflight !== null,
      install: this.installProgress,
      basePath: VSCODE_BASE_PATH,
      lastError: this.lastError,
    };
  }

  /**
   * 準備 (必要ならダウンロード) と起動を開始する。**待たない。**
   * 初回は 108MB のダウンロードが走るので、HTTP レスポンスを掴んだまま
   * 待たせるわけにいかない。クライアントは status をポーリングして進捗を見る。
   *
   * single-flight — タイルを 2 つ同時に開いても二重にダウンロード/起動しない
   * (server/usage.ts の inflight パターンと同じ形)。
   */
  ensure(): void {
    if (this.port !== null || this.inflight) return;
    this.lastError = null;
    this.inflight = this.start()
      .catch((err: unknown) => {
        // 失敗は status.lastError で見せる。ここで握らないと unhandledRejection になる
        this.lastError = err instanceof Error ? err.message : String(err);
        return -1;
      })
      .finally(() => {
        this.inflight = null;
        this.installProgress = null;
      });
  }

  private async start(): Promise<number> {
    let install = resolveInstall();
    if (!install) {
      // 未導入なら取りに行く。PRONTELLA_VSCODE_DIR が指定されているのに
      // 中身が無い場合も含めて、正規の置き場へ入れる。
      await installVsCodium(INSTALL_ROOT, (p) => {
        this.installProgress = p;
      });
      install = resolveInstall();
      if (!install) {
        throw new Error('VSCodium を導入しましたが実行ファイルを解決できません');
      }
    }
    this.installProgress = null;
    this.install = install;
    this.errTail = '';
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    killStaleServer();

    const args = [
      install.main,
      '--host',
      '127.0.0.1',
      // 0 を渡して OS に空きポートを選ばせ、実ポートは起動ログから読む。
      // 本体ポートは固定なので、空きポート探索の既存実装がない。
      '--port',
      '0',
      // 同一オリジンのプロキシ配下 + 127.0.0.1 バインドなのでトークンは不要。
      // CLI ルート共有のトークン衝突もこれで避けられる。
      '--without-connection-token',
      '--server-base-path',
      VSCODE_BASE_PATH,
      '--server-data-dir',
      PROFILE_DIR,
    ];

    const proc = spawn(install.node, args, {
      cwd: install.dir,
      env: terminalEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc = proc;
    if (proc.pid) {
      try {
        fs.writeFileSync(PID_FILE, String(proc.pid));
      } catch {
        // 書けなくても動作には影響しない (孤児の掃除ができなくなるだけ)
      }
    }

    proc.stderr?.on('data', (chunk: Buffer) => {
      this.errTail = (this.errTail + chunk.toString()).slice(-ERR_TAIL_LIMIT);
    });

    proc.on('exit', (code, signal) => {
      // 順序は pty.ts / agentSession.ts に合わせる: 状態を落としてから記録する
      const wasReady = this.port !== null;
      this.proc = null;
      this.port = null;
      if (!wasReady || code !== 0) {
        const why = signal ? `signal ${signal}` : `code ${code}`;
        this.lastError = `VS Code サーバーが終了しました (${why}): ${this.errTail.trim()}`.trim();
      }
    });

    proc.on('error', (err) => {
      this.proc = null;
      this.port = null;
      this.lastError = `VS Code サーバーを起動できません: ${err.message}`;
    });

    try {
      const port = await this.awaitPort(proc);
      this.port = port;
      return port;
    } catch (err) {
      // ポートが読めないまま残ると無言でぶら下がるので必ず殺す
      proc.kill();
      this.proc = null;
      this.port = null;
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  /** stdout を監視して実ポートを取る。時間内に取れなければ失敗させる。 */
  private awaitPort(proc: ChildProcess): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      let out = '';
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        proc.stdout?.off('data', onData);
        proc.off('exit', onExit);
        fn();
      };
      const onData = (chunk: Buffer) => {
        out += chunk.toString();
        const m = PORT_RE.exec(out);
        if (m) done(() => resolve(Number(m[1])));
      };
      const onExit = () =>
        done(() =>
          reject(new Error(`VS Code サーバーが起動せずに終了しました: ${this.errTail.trim()}`)),
        );
      const timer = setTimeout(
        () => done(() => reject(new Error('VS Code サーバーの起動がタイムアウトしました'))),
        START_TIMEOUT_MS,
      );
      proc.stdout?.on('data', onData);
      proc.on('exit', onExit);
    });
  }

  stop(): void {
    this.proc?.kill();
    this.proc = null;
    this.port = null;
    try {
      fs.rmSync(PID_FILE, { force: true });
    } catch {
      // 消せなくても次回の存在確認で弾かれる
    }
  }
}

export const vscodeWeb = new VsCodeWebServer();
