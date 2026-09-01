import net from 'node:net';
import { loadConfig } from './config.js';

/**
 * noVNC (ブラウザー) と ホストで動く VNC サーバーの間の WebSocket↔TCP ブリッジ。
 *
 * 設計上の不変条件:
 * - 接続先はサーバー側の設定 (env / config.json "vnc" キー / 既定値) でのみ決まる。
 *   クライアント (URL クエリ等) から host:port を受けたら任意接続の踏み台になるため、
 *   このモジュールは「接続先を引数で受けない公開経路」を持たない。
 * - `/ws/vnc` のフレームはすべて生の RFB バイト列。JSON テキストを混ぜると noVNC が
 *   RFB としてパースしてプロトコルが壊れ、エラー原因が別物にすり替わる。エラー通知は
 *   WebSocket close code (4000 系) だけで行う。
 */

export interface VncTarget {
  host: string;
  port: number;
}

const DEFAULT_TARGET: VncTarget = Object.freeze({ host: '127.0.0.1', port: 5900 });
// 'localhost' を既定にしない: Node の DNS 解決が ::1 を先に返す環境があり、IPv4 のみ
// バインドする VNC サーバー (TightVNC 等) に届かなくなる。リテラル IPv4 で固定する。

// close code の割当 (4000-4999 はアプリケーション定義領域)
export const CLOSE_CONNECT_FAILED = 4000; // TCP 接続確立に失敗 (VNC サーバー未起動等)
export const CLOSE_TCP_DROPPED = 4001; // 確立後に TCP 側が切断/エラー
export const CLOSE_TOO_MANY = 4002; // 同時ブリッジ数の上限超過

export type VncConfigCheck =
  | { ok: true; target: VncTarget }
  | { ok: false; error: string };

function isValidHost(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  // 制御文字・空白・DEL の混入を弾く。正規表現リテラルに制御バイトを書かない
  // (不可視バイト混入事故の既知パターン)。IDN や IPv6 リテラルは許容する。
  for (let i = 0; i < value.length; i++) {
    const c = value.codePointAt(i)!;
    if (c <= 0x20 || c === 0x7f) return false;
  }
  return true;
}

function isValidPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/**
 * config.json トップレベル "vnc" キーの検証。typeof チェックを先に置く
 * (String/Number 先行の検証は配列や null を化かして素通しさせる教訓)。
 * host / port は個別に省略可能で、省略分は既定値で埋める。
 */
export function checkVncConfig(value: unknown): VncConfigCheck {
  if (value === undefined || value === null) {
    return { ok: true, target: { ...DEFAULT_TARGET } };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'vnc はオブジェクトが必要です (例: { "host": "127.0.0.1", "port": 5900 })' };
  }
  const obj = value as Record<string, unknown>;
  const target: VncTarget = { ...DEFAULT_TARGET };
  if (obj.host !== undefined) {
    if (!isValidHost(obj.host)) {
      return { ok: false, error: 'vnc.host は空でも制御文字/空白を含んでもいけません' };
    }
    target.host = obj.host;
  }
  if (obj.port !== undefined) {
    if (!isValidPort(obj.port)) {
      return { ok: false, error: 'vnc.port は 1〜65535 の整数が必要です' };
    }
    target.port = obj.port;
  }
  return { ok: true, target };
}

/**
 * 接続先の解決を純関数として切り出したもの (loadConfig はモジュールスコープで実ホーム
 * ディレクトリーに固定されており、テストから getVncTarget を直接呼べないため)。
 * 優先順: env (隔離検証・一時変更用) > config.json "vnc" キー > 既定 127.0.0.1:5900。
 * 不正値は理由をログに出して当該項目だけ既定値へ落とす (起動は止めない)。
 */
export function resolveVncTarget(
  configValue: unknown,
  env: { host?: string; port?: string } = {},
  log: (msg: string) => void = (msg) => console.error(msg),
): VncTarget {
  const checked = checkVncConfig(configValue);
  const target = checked.ok ? checked.target : { ...DEFAULT_TARGET };
  if (!checked.ok) {
    log(`[prontella] config.json の vnc 設定が不正なため既定値を使います: ${checked.error}`);
  }
  if (env.host !== undefined) {
    if (isValidHost(env.host)) {
      target.host = env.host;
    } else {
      log('[prontella] PRONTELLA_VNC_HOST が不正なため無視します');
    }
  }
  if (env.port !== undefined) {
    const port = Number(env.port);
    if (isValidPort(port)) {
      target.port = port;
    } else {
      log(`[prontella] PRONTELLA_VNC_PORT が不正なため無視します: ${env.port}`);
    }
  }
  return target;
}

export function getVncTarget(): VncTarget {
  let configValue: unknown;
  try {
    configValue = loadConfig().vnc;
  } catch {
    // config.json 破損時は loadConfig が投げ続ける仕様 (config.ts 参照)。VNC 機能は
    // 既定値で動作を続ける (破損の告知は config を実際に読み書きする経路が担う)。
    configValue = undefined;
  }
  return resolveVncTarget(configValue, {
    host: process.env.PRONTELLA_VNC_HOST,
    port: process.env.PRONTELLA_VNC_PORT,
  });
}

/**
 * ws.WebSocket の構造的サブセット。テストでは EventEmitter ベースの偽ソケットを渡し、
 * server/index.ts をロードせずにブリッジ単体を実 TCP + 偽 WS で検証する
 * (index.ts はモジュールスコープに副作用があり import できない — index.test.ts の教訓)。
 */
export interface BridgeSocket {
  readyState: number;
  bufferedAmount: number;
  send(data: Buffer, options: { binary: boolean }, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: 'close' | 'error', listener: (...args: unknown[]) => void): unknown;
}

const WS_OPEN = 1; // ws.WebSocket.OPEN (定数参照のためだけに ws を import しない)

// TCP→WS の backpressure 閾値。noVNC 側の受信が遅い (大画面 + 低速回線) とき、
// ws の送信バッファが無制限に伸びて Node のメモリを食い潰すのを防ぐ。
const BUFFER_HIGH_WATER = 4 * 1024 * 1024;
const BUFFER_LOW_WATER = 1 * 1024 * 1024;

// 暴走ループ保険の同時ブリッジ数上限。多重接続の可否そのものは VNC サーバー側の
// shared 設定に委ね、ここでは人工的に絞らない。
const MAX_BRIDGES = 16;
let activeBridges = 0;

/** テスト用: 現在の同時ブリッジ数。 */
export function activeBridgeCount(): number {
  return activeBridges;
}

/**
 * WebSocket と VNC サーバーへの TCP 接続を双方向にパイプする。
 * ws 側・tcp 側どちらが先に死んでも、もう一方を必ず閉じて数を戻す (対称クリーンアップ)。
 */
export function attachVncBridge(ws: BridgeSocket, target: VncTarget = getVncTarget()): void {
  if (activeBridges >= MAX_BRIDGES) {
    try {
      ws.close(CLOSE_TOO_MANY, 'too many vnc connections');
    } catch {
      // close 済みソケットへの close は無視
    }
    return;
  }
  activeBridges++;

  let finished = false;
  let tcpConnected = false;
  // TCP 接続確立前に届いたクライアントフレームの待機列。RFB はサーバー先行ハンドシェイク
  // だが、noVNC が接続直後に送るフレームをここで捨てるとハンドシェイクが固まる。
  let pending: Buffer[] = [];
  let tcpPaused = false;

  const tcp = net.connect({ host: target.host, port: target.port });
  tcp.setNoDelay(true); // 入力イベントは小さく、体感遅延に直結するため Nagle を切る

  // 終端処理は一本化する。code が指定されたときのみ WS を能動的に閉じる
  // (WS 起点の終了では既に閉じているので二重 close しない)。
  const finish = (code?: number, reason?: string): void => {
    if (finished) return;
    finished = true;
    activeBridges--;
    pending = [];
    tcp.destroy();
    if (code !== undefined) {
      try {
        ws.close(code, reason);
      } catch {
        // 既に閉じている場合は無視
      }
    }
  };

  tcp.on('connect', () => {
    tcpConnected = true;
    for (const buf of pending) tcp.write(buf);
    pending = [];
  });

  tcp.on('error', (err: NodeJS.ErrnoException) => {
    // reason には code 名のみ載せる (close reason は 123 バイト制限)
    finish(tcpConnected ? CLOSE_TCP_DROPPED : CLOSE_CONNECT_FAILED, err.code ?? 'ERROR');
  });

  tcp.on('close', () => {
    finish(CLOSE_TCP_DROPPED, 'vnc server closed connection');
  });

  const maybeResume = (): void => {
    if (tcpPaused && ws.bufferedAmount <= BUFFER_LOW_WATER) {
      tcpPaused = false;
      tcp.resume();
    }
  };

  tcp.on('data', (chunk: Buffer) => {
    if (finished || ws.readyState !== WS_OPEN) return;
    // callback は ws の送信バッファからカーネルへ書き出された時点で呼ばれる。
    // ws に drain イベントは無いため、これを低水位チェックの契機にする。
    ws.send(chunk, { binary: true }, () => maybeResume());
    if (!tcpPaused && ws.bufferedAmount > BUFFER_HIGH_WATER) {
      tcpPaused = true;
      tcp.pause();
    }
  });

  ws.on('message', (data, isBinary) => {
    if (finished) return;
    if (!isBinary) {
      // noVNC はテキストフレームを送らない。プロトコル違反として即終了 (1003 = unsupported data)
      finish(1003, 'text frames are not allowed');
      return;
    }
    const buf = Buffer.isBuffer(data)
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(data as ArrayBuffer);
    if (tcpConnected) {
      // クライアント→サーバー方向は入力イベント (数十バイト級) のみなので、v1 では
      // write の戻り値による backpressure 制御は行わない (ws 側の受信を止める公開 API が無い)。
      tcp.write(buf);
    } else {
      pending.push(buf);
    }
  });

  ws.on('close', () => finish());
  ws.on('error', () => finish());
}

/**
 * 設定済みターゲットへの TCP 到達性プローブ。クライアントの接続前プリフライトと
 * エラー画面の文言出し分けに使う。引数で任意の接続先を受けない
 * (受けるとポートスキャン器になる)。
 */
export function probeVncTarget(timeoutMs = 1000): Promise<{ reachable: boolean }> {
  const target = getVncTarget();
  return new Promise((resolve) => {
    const socket = net.connect({ host: target.host, port: target.port });
    let settled = false;
    const settle = (reachable: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ reachable });
    };
    socket.setTimeout(timeoutMs, () => settle(false));
    socket.on('connect', () => settle(true));
    socket.on('error', () => settle(false));
  });
}
