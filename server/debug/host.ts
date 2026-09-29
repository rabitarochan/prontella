import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { createMessageReader, encodeMessage } from '../lsp/framing.js';
import type { Launch } from './registry.js';

/**
 * デバッグアダプタープロセス 1 本 (= 1 デバッグ実行)。LSP の host と違い共有もアイドル管理もしない: WS が閉じたら kill する。
 *
 * - `tcp` (vscode-js-debug): `0 127.0.0.1` を渡すと空きポートで listen し、stdout に
 *   `Debug server listening at 127.0.0.1:<port>` を 1 行出す。1 接続 = 1 DAP セッションで、startDebugging ごとに接続が増える
 * - `stdio` (netcoredbg `--interpreter=vscode`): stdin/stdout が唯一の接続。connect() は 1 回だけ
 * フレーミングはどちらも Content-Length (server/lsp/framing.ts)
 */

export interface DapMessage {
  seq?: number;
  type?: string;
  command?: string;
  event?: string;
  request_seq?: number;
  success?: boolean;
  message?: string;
  arguments?: unknown;
  body?: unknown;
  [key: string]: unknown;
}

export interface AdapterConn {
  send(msg: DapMessage): void;
  close(): void;
}

export interface Adapter {
  readonly port: number;
  readonly pid: number | undefined;
  connect(onMessage: (msg: DapMessage) => void, onClose: () => void): AdapterConn;
  kill(): void;
  stderrTail(): string;
}

export interface StartOptions {
  launch: Launch;
  cwd: string;
  env: Record<string, string>;
  onExit: (code: number | null, signal: string | null) => void;
  spawn?: typeof nodeSpawn;
  listenTimeoutMs?: number;
}

const STDERR_TAIL = 4096;
const LISTEN_TIMEOUT_MS = 15_000;
const LISTEN_RE = /listening at [^:\s]+:(\d+)/;

export function startAdapter(opts: StartOptions): Promise<Adapter> {
  const { launch } = opts;
  const stdio = launch.transport === 'stdio';
  // shell: true は禁止 (cp932 化けと注入)。env は terminalEnv (デバッギーはユーザーのコード)
  const child: ChildProcess = (opts.spawn ?? nodeSpawn)(launch.command, stdio ? launch.args : [...launch.args, '0', '127.0.0.1'], {
    cwd: opts.cwd,
    windowsHide: true,
    stdio: [stdio ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    env: opts.env,
  });
  let stderr = '';
  let stdout = '';
  let exited = false;
  const stderrTail = () => stderr;
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL);
  });
  child.on('error', (err) => {
    stderr += `\n[spawn] ${err.message}`;
  });
  return new Promise<Adapter>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`アダプターが ${LISTEN_TIMEOUT_MS / 1000} 秒以内に listen しませんでした: ${stderr.trim()}`)), opts.listenTimeoutMs ?? LISTEN_TIMEOUT_MS);
    timer.unref();
    if (stdio) {
      clearTimeout(timer);
      resolve(stdioAdapter(child, stderrTail));
    } else {
      child.stdout!.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        const m = LISTEN_RE.exec(stdout);
        if (!m) return;
        clearTimeout(timer);
        resolve(tcpAdapter(Number(m[1]), child, stderrTail));
      });
    }
    child.on('exit', (code, signal) => {
      exited = true;
      clearTimeout(timer);
      reject(new Error(`アダプターが終了しました (code=${code}): ${stderr.trim()}`));
      opts.onExit(code, signal);
    });
    child.on('error', () => {
      if (!exited) {
        exited = true;
        clearTimeout(timer);
        reject(new Error(`アダプターを起動できません: ${stderr.trim()}`));
      }
    });
  });
}

function killChild(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) child.kill();
}

function tcpAdapter(port: number, child: ChildProcess, stderrTail: () => string): Adapter {
  const sockets = new Set<net.Socket>();
  return {
    port,
    pid: child.pid,
    stderrTail,
    connect(onMessage, onClose) {
      const sock = net.connect({ host: '127.0.0.1', port });
      sockets.add(sock);
      const reader = createMessageReader(
        (msg) => onMessage(msg as DapMessage),
        () => sock.destroy(), // フレーミングが壊れたら接続ごと捨てる (同期点が無い)
      );
      sock.on('data', (chunk: Buffer) => reader.push(chunk));
      sock.on('error', () => {});
      sock.on('close', () => {
        sockets.delete(sock);
        onClose();
      });
      return {
        send(msg) {
          if (!sock.destroyed) sock.write(encodeMessage(msg));
        },
        close() {
          sock.destroy();
        },
      };
    },
    kill() {
      for (const s of sockets) s.destroy();
      killChild(child);
    },
  };
}

function stdioAdapter(child: ChildProcess, stderrTail: () => string): Adapter {
  let connected = false;
  return {
    port: 0,
    pid: child.pid,
    stderrTail,
    connect(onMessage, onClose) {
      if (connected) throw new Error('stdio アダプターは接続を 1 本しか持てません');
      connected = true;
      const reader = createMessageReader(
        (msg) => onMessage(msg as DapMessage),
        () => killChild(child),
      );
      child.stdout!.on('data', (chunk: Buffer) => reader.push(chunk));
      child.on('exit', () => onClose());
      return {
        send(msg) {
          if (child.exitCode === null && child.signalCode === null && child.stdin!.writable) child.stdin!.write(encodeMessage(msg));
        },
        close() {
          killChild(child);
        },
      };
    },
    kill() {
      killChild(child);
    },
  };
}
