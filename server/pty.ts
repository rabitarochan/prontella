import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as pty from 'node-pty';
import type { WebSocket } from 'ws';
import { envGet, terminalEnv, windowsExecutableCandidates } from './childEnv.js';
import {
  applyClaudeHookEvent,
  clearWork,
  createHookState,
  isClaudeHookPayload,
  subagentList,
  type ClaudeHookState,
  type HookSubagent,
} from './claudeHookState.js';
import { claudeCommand } from './hooks.js';
import { broadcastEvent, registerSnapshotProvider } from './sessionEvents.js';
import { ScreenMirror } from './screenMirror.js';
import { parseResizeMessage } from './termProtocol.js';

export type AgentStatus = 'busy' | 'waiting' | 'idle' | 'shell';

// attach 時に再生するスクロールバックの行数 (サーバー側 headless xterm の保持量)。
// クライアント (XTermView) は 5000 行だが、再接続で戻す履歴は 1000 行に絞る:
// シリアライズ量 (= attach の待ち時間) と resize 時の再折り返しコストは保持行数に
// 比例し、5000 行だと 8 セッションの一斉再接続で 2.6 MB / 2.5 秒になった (計測)。
const MIRROR_SCROLLBACK_LINES = 1000;
// spawn 時の PTY サイズ。最初の attach クライアントが fit() で上書きするまでの仮の値。
const INITIAL_COLS = 120;
const INITIAL_ROWS = 32;
const BUSY_HOLD_MS = 3_000; // spinner redraw gap tolerance
// hook セッションが busy のまま無音でいられる上限。超えたら作業状態を捨てて idle に
// 落とす (hook 断で永久 busy に固着させないための保険)。バックグラウンドのサブ
// エージェントは分単位で無音になりうるので、スピナー用の 3 秒とは桁が違う。
const HOOK_STALE_MS = 10 * 60_000;
const ACTIVITY_FLUSH_MS = 250; // activity 変化の broadcastEvent 合体窓
const CARRY_MAX = 400; // stripped chars carried over to match across chunk splits
const FLUSH_MS = 16; // ws 'data' broadcast coalescing window (~1 frame)
const MAX_PENDING = 64 * 1024; // chars; burst guard — flush immediately past this

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

// DEC private modes worth tracking across scrollback trims: modes that change
// how input is interpreted (bracketed paste, mouse tracking) and thus don't
// self-heal on redraw the way visual state does, plus cursor visibility (25),
// which the client's term.reset() forces back on regardless of prior state.
const TRACKED_MODES = new Set([1, 9, 25, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 2004]);
// eslint-disable-next-line no-control-regex
const DECSET_RE = /\x1b\[\?([0-9;]+)([hl])/g;

// ConPTY v2 (node-pty 同梱の conpty.dll) は起動直後に端末へ DA1 (Primary Device
// Attributes, `ESC[c`) を投げ、返事が来るまで子プロセスの出力を握ったまま待つ。
// in-box の ConPTY は投げないので、これは v2 に切り替えて初めて出る挙動。
// node-pty 自身は端末ではないので誰も答えず、タイムアウトの約 3 秒がまるごと
// 起動時間に乗る (実測: cmd.exe で 124ms → 3134ms、pwsh で 1.4s → 3.9s。
// 3.1s ±40ms とほぼ一定なのでスキャン等ではなくタイマー)。
// 応答は「VT100 with Advanced Video Option」— xterm.js が返すのと同じ値。
const DA1_QUERY = '\x1b[c';
const DA1_REPLY = '\x1b[?1;2c';

// NOTE: the Claude Code TUI positions text with cursor moves, so after ANSI
// stripping spaces between words are often missing ("shift+tabtocycle").
// Patterns below must tolerate that (\s* instead of literal spaces).
//
// Busy: the spinner glyphs (✢ ✶ ✻ ✽) redraw every ~100ms while working.
// Older versions also printed "(esc to interrupt)".
const BUSY_RE = /esc\s*to\s*interrupt|[✻✶✽✢]/i;
// Waiting: every permission / trust / plan dialog renders a numbered option
// list with a cursor ("❯ 1. Yes"). Plain prose almost never contains it.
const PROMPT_RE = /❯\s*1\.|\(y\/n\)|press\s*enter\s*to\s*continue/i;
// Claude TUI markers: banner text (older versions) or the persistent footer
// ("Model: Fable 5 | Ctx: ..." / "⏵⏵ auto mode on (shift+tab to cycle)"),
// which redraws constantly so detection self-heals even if the banner is missed.
const CLAUDE_UI_RE =
  /claude\s*code|welcome\s*to\s*claude|anthropic|model:[^\n|]{1,40}\|\s*ctx:|shift\+?\s*tab\s*to\s*cycle|⏵⏵/i;
// A PowerShell prompt at the very end of output means we are back in the shell.
const SHELL_RETURN_RE = /(^|\n)PS [^\n]{0,200}> ?$/;

/** End offset of the last match of `re` in `text`, or 0 if no match. */
function lastMatchEnd(text: string, re: RegExp): number {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let end = 0;
  let m: RegExpExecArray | null;
  while ((m = g.exec(text)) !== null) {
    end = m.index + m[0].length;
    if (m[0].length === 0) g.lastIndex++;
  }
  return end;
}

/** hook 由来の「いま何をしているか」。hook が 1 度も届いていないセッションは null。 */
export interface AgentActivity {
  /** リードが実行中のツールの要約 ("Bash: npm test")。無ければ null。 */
  tool: string | null;
  toolSince: number | null;
  subagents: HookSubagent[];
  /** background_tasks にサブエージェント以外の走行中タスクが載っている。 */
  backgroundTask: boolean;
}

export interface SessionInfo {
  id: string;
  cwd: string;
  title: string;
  /** 'pty' = ターミナル (xterm)、'sdk' = Agent SDK チャットセッション */
  kind: 'pty' | 'sdk';
  status: AgentStatus;
  claudeDetected: boolean;
  createdAt: number;
  lastOutputAt: number;
  statusSince: number;
  activity: AgentActivity | null;
}

/** Aggregate agent status for a set of sessions: most attention-needing wins. */
export function aggregateStatus(
  sessions: SessionInfo[],
): { status: AgentStatus | 'none'; terminalId: string | null } {
  if (sessions.length === 0) return { status: 'none', terminalId: null };
  const order: AgentStatus[] = ['waiting', 'busy', 'idle', 'shell'];
  for (const status of order) {
    const hit = sessions.find((s) => s.status === status);
    if (hit) return { status, terminalId: hit.id };
  }
  return { status: 'shell', terminalId: sessions[0].id };
}

interface Session {
  id: string;
  cwd: string;
  title: string;
  proc: pty.IPty;
  /** 現在の PTY winsize。attach 時の snapshot と resize broadcast で全クライアントへ配る。 */
  cols: number;
  rows: number;
  /** サーバー側の画面の鏡 (headless xterm)。attach 時の snapshot はここからシリアライズする。 */
  mirror: ScreenMirror;
  /** attach 処理中 (snapshot のシリアライズ待ち) のソケットへ後送りする出力。 */
  attaching: Set<string[]>;
  carry: string; // stripped tail carried into the next chunk's pattern scan
  modes: Map<number, boolean>; // last seen state of TRACKED_MODES (true = set/h); unseen modes are absent
  modeCarry: string; // raw tail carried into the next chunk's DECSET_RE scan
  da1Answered: boolean; // ConPTY v2 の起動時 DA1 に一度だけ答えたか
  pending: string; // unflushed 'data' broadcast payload, coalesced within FLUSH_MS
  flushTimer: NodeJS.Timeout | null;
  sockets: Set<WebSocket>;
  status: AgentStatus;
  claudeDetected: boolean;
  lastBusyAt: number;
  lastOutputAt: number;
  createdAt: number;
  statusSince: number;
  exited: boolean;
  /** hook を 1 度でも受けたら生える。非 null = このセッションは hook が権威。 */
  hook: ClaudeHookState | null;
  activityTimer: NodeJS.Timeout | null;
}

/** PATH / PATHEXT を辿って実行ファイルの実体を探す (Windows)。無ければ null。 */
function findWindowsExecutable(exe: string, env: Record<string, string>): string | null {
  const pathValue = envGet(env, 'PATH') ?? '';
  const pathExt = envGet(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD';
  for (const candidate of windowsExecutableCandidates(exe, pathValue, pathExt)) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // 次の候補へ
    }
  }
  return null;
}

/** 解決済みの Windows 既定シェル。プロセスで一度だけ決める。 */
let windowsShellCache: { file: string; args: string[] } | null = null;

/**
 * Windows の既定シェル: pwsh (PowerShell 7+) があればそちら、無ければ
 * Windows PowerShell 5.1 (`powershell.exe`) にフォールバックする。
 * `PRONTELLA_SHELL` を指定するとそれを優先する (解決できなければ警告して既定へ)。
 *
 * なぜ pwsh を優先するか (2026-09-01 実測):
 * 5.1 に同梱の PSReadLine は 2.0.0 で、予測入力 (Predictive IntelliSense) が
 * 実装されていない (`Set-PSReadLineOption` に `-PredictionSource` が無い)。
 * childEnv.ts で PTY の env を「新規端末相当」に再構成する前は、deck を pwsh から
 * 起動していると PTY が PS7 の PSModulePath を継承し、5.1 が PS7 同梱の
 * PSReadLine 2.4.5 を拾って予測が効いていた — が、これは起動元シェルに依存する
 * 偶然で、素の powershell.exe を開いた状態では元々効かない。
 * PS7 ユーザーにとっての「新規端末」は pwsh なので、env を戻すのではなく
 * シェル側を合わせる。実測: pwsh 7.6.5 / PSReadLine 2.4.5 /
 * PredictionSource=HistoryAndPlugin / InlineView。
 */
function windowsShell(): { file: string; args: string[] } {
  if (windowsShellCache) return windowsShellCache;
  const env = terminalEnv();
  const args = ['-NoLogo'];
  const override = process.env.PRONTELLA_SHELL?.trim();
  if (override) {
    // 絶対パス指定と PATH 上の名前指定の両方を受ける
    const resolved = path.isAbsolute(override)
      ? (fs.existsSync(override) ? override : null)
      : findWindowsExecutable(override, env);
    if (resolved) {
      windowsShellCache = { file: resolved, args };
      return windowsShellCache;
    }
    console.warn(
      `[prontella] PRONTELLA_SHELL=${override} が見つかりません。既定のシェルを使います。`,
    );
  }
  const pwsh = findWindowsExecutable('pwsh.exe', env);
  windowsShellCache = { file: pwsh ?? 'powershell.exe', args };
  return windowsShellCache;
}

function defaultShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') return windowsShell();
  return { file: terminalEnv().SHELL || 'bash', args: [] };
}

/**
 * Windows: node-pty が同梱する conpty.dll (Windows Terminal 1.23 系) を使うかどうか。
 *
 * OS 同梱 (in-box) の ConPTY は、子プロセスの VT を一度テキストバッファに起こしてから
 * その画面スナップショットを再レンダリングして VT に戻す旧世代。node-pty が同梱する
 * conpty.dll は Windows Terminal 1.22 以降の新世代で、子プロセスの VT をそのまま
 * ホスト側のパイプへ流す (素通し)。スクロールの重い出力ほど差が出る。
 * DLL は npm install 時点で node-pty のネイティブモジュールと同じ場所に入っているので、
 * こちらで配置する作業は要らない — フラグを立てるだけで切り替わる。
 *
 * upstream ではまだ EXPERIMENTAL 扱いなので、spawn が落ちたら in-box ConPTY に
 * 落として続行する (conptyDllDisabled をラッチして以降は試さない)。
 * `PRONTELLA_CONPTY_DLL=0` で最初から無効化できる。
 */
let conptyDllDisabled =
  process.platform !== 'win32' || process.env.PRONTELLA_CONPTY_DLL?.trim() === '0';

function conptyOptions(): { useConptyDll?: true } {
  return conptyDllDisabled ? {} : { useConptyDll: true };
}

/**
 * 起動時ログ用に、どちらの ConPTY を使う設定かを 1 行で返す (Windows 以外は null)。
 *
 * conpty.dll が実際にロードされるのは最初の PTY 起動時なので、これは「使うつもり」の値。
 * spawn に失敗して OS 同梱へ落ちた場合は create() が別途 warn を出す。
 */
export function conptyMode(): string | null {
  if (process.platform !== 'win32') return null;
  return conptyDllDisabled
    ? 'OS 同梱 (in-box)'
    : 'node-pty 同梱 conpty.dll (Windows Terminal 1.23 系)';
}

export class PtyManager {
  private sessions = new Map<string, Session>();
  private timer: NodeJS.Timeout;

  constructor(private port: number) {
    this.timer = setInterval(() => this.tick(), 1_000);
    this.timer.unref();
    registerSnapshotProvider(() => this.list());
  }

  create(cwd: string, run?: 'claude' | string): SessionInfo {
    const id = randomUUID().slice(0, 8);
    const shell = defaultShell();
    const options: pty.IWindowsPtyForkOptions = {
      name: 'xterm-256color',
      cols: INITIAL_COLS,
      rows: INITIAL_ROWS,
      cwd,
      // terminalEnv(): deck の process.env ではなく「OS で新規に端末を開いた」環境。
      // deck の起動元シェルの汚染 (NODE_ENV/PORT/NO_COLOR/GIT_EDITOR ...) を持ち込まない。
      // PRONTELLA_* は deck-hook.mjs がイベントの届け先とセッションを
      // 特定するための変数。claude 経由でフックの子プロセスまで届く。
      env: terminalEnv({
        PRONTELLA_PORT: String(this.port),
        PRONTELLA_TERM: id,
      }),
    };
    let proc: pty.IPty;
    try {
      proc = pty.spawn(shell.file, shell.args, { ...options, ...conptyOptions() });
    } catch (err) {
      if (conptyDllDisabled) throw err;
      // 同梱 conpty.dll でのみ落ちるケース (DLL 欠損・環境制約) は in-box に落として続行する。
      conptyDllDisabled = true;
      console.warn(
        `[prontella] 同梱 conpty.dll での PTY 起動に失敗しました。OS 同梱の ConPTY に戻します: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      proc = pty.spawn(shell.file, shell.args, options);
    }
    const session: Session = {
      id,
      cwd: path.resolve(cwd),
      title: run ? 'Claude Code' : path.basename(cwd),
      proc,
      cols: INITIAL_COLS,
      rows: INITIAL_ROWS,
      mirror: new ScreenMirror(INITIAL_COLS, INITIAL_ROWS, MIRROR_SCROLLBACK_LINES),
      attaching: new Set(),
      carry: '',
      modes: new Map(),
      modeCarry: '',
      da1Answered: false,
      pending: '',
      flushTimer: null,
      sockets: new Set(),
      status: 'shell',
      claudeDetected: false,
      lastBusyAt: 0,
      lastOutputAt: Date.now(),
      createdAt: Date.now(),
      statusSince: Date.now(),
      exited: false,
      hook: null,
      activityTimer: null,
    };
    this.sessions.set(session.id, session);

    proc.onData((data) => this.onData(session, data));
    proc.onExit(() => {
      this.flush(session);
      if (session.activityTimer) clearTimeout(session.activityTimer);
      session.activityTimer = null;
      session.exited = true;
      this.broadcast(session, { type: 'exit' });
      for (const ws of session.sockets) ws.close();
      session.mirror.dispose();
      this.sessions.delete(session.id);
      broadcastEvent({ type: 'removed', id: session.id });
    });

    if (run) {
      // "claude" は hooks 設定つきの完全なコマンドラインに展開する。
      const command = run === 'claude' ? claudeCommand(this.port) : run;
      // Let the shell finish initializing before injecting the command, so it
      // lands on a ready prompt across PowerShell / bash / zsh.
      const eol = '\r';
      setTimeout(() => {
        if (!session.exited) proc.write(command + eol);
      }, process.platform === 'win32' ? 1_200 : 400);
    }
    broadcastEvent({ type: 'session', session: this.toInfo(session) });
    return this.toInfo(session);
  }

  attach(id: string, ws: WebSocket): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    // snapshot は headless xterm のシリアライズで、write キューが掃けるのを待つ
    // (非同期)。その間に届いた出力は `queued` に積み、snapshot の直後に順番どおり
    // 送ってからライブ配信 (session.sockets) へ加える。こうすると新しいソケットは
    // 出力を「snapshot 経由で 1 回」か「後送り経由で 1 回」のどちらかで必ず 1 回
    // だけ受け取る (snapshot 前の pending はここで flush して既存ソケットへ流す)。
    this.flush(session);
    const queued: string[] = [];
    session.attaching.add(queued);
    session.mirror.snapshot((screen) => {
      session.attaching.delete(queued);
      if (ws.readyState !== ws.OPEN) return;
      // serialize は DEC モードも書き出すが、追跡中のモード (bracketed paste・マウス・
      // カーソル可視) は明示的に前置しておく。クライアントは reset() してから再生する
      // ので、既定 on のモードの "off" も含めて送る必要がある。冪等なので二重でも無害。
      const prefix = [...session.modes.entries()]
        .sort(([a], [b]) => a - b)
        .map(([mode, on]) => `\x1b[?${mode}${on ? 'h' : 'l'}`)
        .join('');
      // cols/rows: 非アクティブなページ (フォーカスのないタブ/ウィンドウ) は自分の
      // 寸法を主張せず、この値に格子を合わせて鏡写しする (client XTermView)。
      ws.send(
        JSON.stringify({
          type: 'snapshot',
          data: prefix + screen,
          cols: session.cols,
          rows: session.rows,
        }),
      );
      ws.send(JSON.stringify({ type: 'status', status: session.status }));
      if (queued.length > 0) ws.send(Buffer.from(queued.join(''), 'utf8'), { binary: true });
      if (!session.exited) session.sockets.add(ws);
    });
    ws.on('message', (raw) => {
      let msg: { type: string; data?: string; cols?: unknown; rows?: unknown };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (session.exited) return;
      if (msg.type === 'input' && typeof msg.data === 'string') {
        // Answering a dialog leaves "waiting"; the next spinner frame promotes
        // to busy again, otherwise the session settles on idle.
        // hook セッションでは撃たない: 次の hook イベントが正しい状態を運ぶので、
        // ここで idle に落とすと走行中のサブエージェントを消してしまう。
        if (session.status === 'waiting' && !session.hook) this.setStatus(session, 'idle');
        session.proc.write(msg.data);
      } else if (msg.type === 'resize') {
        const size = parseResizeMessage(msg);
        if (size) this.resizePty(session, size.cols, size.rows);
      }
    });
    ws.on('close', () => {
      session.sockets.delete(ws);
      session.attaching.delete(queued);
    });
    return true;
  }

  /**
   * PTY の winsize は 1 つしかない (last-write-wins)。サイズが変わるときは
   * `proc.resize` の**前に**全 attach ソケットへ新サイズを流す — 追従側の
   * クライアントが格子を合わせてから TUI の再描画出力を受け取れるように。
   * 同サイズでも `proc.resize` は呼ぶ (再接続時に同じ値を送り直す既存挙動を維持)。
   */
  private resizePty(session: Session, cols: number, rows: number): void {
    const changed = cols !== session.cols || rows !== session.rows;
    session.cols = cols;
    session.rows = rows;
    session.mirror.resize(cols, rows);
    if (changed) this.broadcast(session, { type: 'resize', cols, rows });
    try {
      session.proc.resize(cols, rows);
    } catch {
      // resize can race with exit
    }
  }

  /**
   * Claude Code の hook イベントを反映する (HTTP hook からの POST)。
   *
   * 状態の決定は claudeHookState.ts の純関数に委ねる。ここは「どのセッションか」を
   * 引き当てて、返ってきたステータスと表示内容を配信するだけ。
   *
   * hook を 1 度でも受けたセッションは **hook が権威**になり、TUI ヒューリスティック
   * (スピナー/ダイアログ検出と 3 秒タイムアウト) をステータス決定から降ろす。
   * ヒューリスティックはサブエージェントの走行を知らないので、長時間ツールや
   * バックグラウンドの子を「待ち」に落としてしまうため。
   */
  applyHookEvent(id: string, payload: Record<string, unknown>): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    // hook として解釈できない本文でセッションを hook 権威に切り替えない
    // (切り替えるとヒューリスティックが降り、ゴミ POST 1 発で検知を殺せる)。
    if (!isClaudeHookPayload(payload)) return false;
    if (!session.hook) session.hook = createHookState(Date.now());
    session.claudeDetected = true;
    const { status, changed } = applyClaudeHookEvent(session.hook, payload, Date.now());
    if (status === 'shell') {
      session.claudeDetected = false;
      session.hook = null;
      this.setStatus(session, 'shell');
      return true;
    }
    if (status === 'busy') session.lastBusyAt = Date.now();
    if (status) this.setStatus(session, status);
    // ステータスが据え置きでもツール/サブエージェントは動く。status 側の早期 return に
    // 巻き込まれないよう、表示内容の変化は別経路で配信する。
    if (changed) this.scheduleActivityPublish(session);
    return true;
  }

  /**
   * activity 変化の配信。1 ツールにつき Pre/Post の 2 発 × サブエージェント本数
   * まで増えるので、短い窓で合体させてから 1 回だけ流す。
   */
  private scheduleActivityPublish(session: Session): void {
    if (session.activityTimer) return;
    session.activityTimer = setTimeout(() => {
      session.activityTimer = null;
      if (session.exited) return;
      broadcastEvent({ type: 'session', session: this.toInfo(session) });
    }, ACTIVITY_FLUSH_MS);
    session.activityTimer.unref();
  }

  kill(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.proc.kill();
    return true;
  }

  list(cwd?: string): SessionInfo[] {
    const all = [...this.sessions.values()].map((s) => this.toInfo(s));
    if (!cwd) return all;
    const target = normalizePath(cwd);
    return all.filter((s) => normalizePath(s.cwd) === target);
  }

  /** Aggregate agent status for a worktree path: most attention-needing wins. */
  statusFor(cwd: string): { status: AgentStatus | 'none'; terminalId: string | null } {
    return aggregateStatus(this.list(cwd));
  }

  private onData(session: Session, data: string): void {
    session.lastOutputAt = Date.now();

    // DA1 に答えて ConPTY v2 の起動待ちを解く (DA1_QUERY のコメント参照)。
    // **サーバーが必ず答える**: クライアントの attach 待ちにすると、attach が
    // クエリーより先か後かで 3 秒待つかどうかが変わり、起動時間が 1.7〜6.4 秒に
    // ばらついた (実測)。attach 済みでも xterm.js に頼らない。
    // 代わりにクエリー自体を中継から取り除く — これをそのまま流すと xterm.js も
    // DA1 に答え、二重応答の `ESC[?1;2c` がシェルの入力として打ち込まれる。
    // 端末への問い合わせであって表示内容ではないので、落として困るものはない。
    if (!session.da1Answered && data.includes(DA1_QUERY)) {
      session.da1Answered = true;
      session.proc.write(DA1_REPLY);
      data = data.replace(DA1_QUERY, '');
    }

    session.mirror.write(data);
    for (const queue of session.attaching) queue.push(data);
    session.pending += data;
    if (session.pending.length > MAX_PENDING) {
      // Burst guard: flush immediately rather than let pending (and latency) grow unbounded.
      this.flush(session);
    } else if (!session.flushTimer) {
      session.flushTimer = setTimeout(() => this.flush(session), FLUSH_MS);
      session.flushTimer.unref();
    }

    // Track DEC private mode changes (raw, unstripped) so a reattach can replay
    // them even after the sequence itself has scrolled out of `scrollback`.
    // Scanning modeCarry + data re-covers the carried tail, but that's safe:
    // set/reset assignments are idempotent and the carry precedes the new
    // chunk, so re-applying it can't change the final state or its order.
    const modeScan = session.modeCarry + data;
    let modeMatch: RegExpExecArray | null;
    DECSET_RE.lastIndex = 0;
    while ((modeMatch = DECSET_RE.exec(modeScan)) !== null) {
      const on = modeMatch[2] === 'h';
      for (const param of modeMatch[1].split(';')) {
        const n = Number(param);
        if (TRACKED_MODES.has(n)) session.modes.set(n, on);
      }
    }
    session.modeCarry = modeScan.slice(-64);

    // Scan carry + new chunk so phrases split across chunk boundaries still match.
    const scan = session.carry + data.replace(ANSI_RE, '');

    if (!session.claudeDetected && CLAUDE_UI_RE.test(scan)) {
      session.claudeDetected = true;
      if (session.status === 'shell') this.setStatus(session, 'idle');
    }

    // The signal that appears LATER in the stream wins: a dialog drawn after
    // the last spinner frame means "waiting", a spinner frame after a dialog
    // means the question was answered and work resumed.
    const busyEnd = lastMatchEnd(scan, BUSY_RE);
    const promptEnd = session.claudeDetected ? lastMatchEnd(scan, PROMPT_RE) : 0;
    // hook が権威のセッションでは、スピナー/ダイアログからステータスを決めない。
    // PROMPT_RE ("❯ 1." 等) はエージェントの出力本文にも当たり、実行中を誤って
    // waiting に落とす。シェル復帰の検出だけは残す (プロセスが消えた事実は
    // hook からは分からないため)。
    const heuristicOwnsStatus = session.hook === null;
    if (heuristicOwnsStatus && promptEnd > busyEnd) {
      this.setStatus(session, 'waiting');
    } else if (heuristicOwnsStatus && busyEnd > 0) {
      session.lastBusyAt = Date.now();
      session.claudeDetected = true; // a spinner implies an agent TUI
      this.setStatus(session, 'busy');
    } else if (
      session.claudeDetected &&
      // hook セッションは busy 中でも見る: claude が SessionEnd を出せずに落ちた場合
      // (クラッシュ・強制終了)、これを塞ぐと stale ガードの 10 分間 busy に居座る。
      (session.status !== 'busy' || session.hook !== null) &&
      SHELL_RETURN_RE.test(scan)
    ) {
      // Claude exited and the shell prompt is back. If this is a false hit
      // (prompt-like text inside Claude output), the footer redraw re-detects.
      session.claudeDetected = false;
      session.hook = null;
      this.setStatus(session, 'shell');
    }

    // Trim past the last match so stale text cannot re-trigger on the next chunk.
    session.carry = scan.slice(Math.max(busyEnd, promptEnd, scan.length - CARRY_MAX));
  }

  private tick(): void {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (session.status !== 'busy') continue;
      if (session.hook) {
        // hook が権威のセッションは 3 秒のスピナー猶予では降格させない
        // (バックグラウンドのサブエージェントは分単位で無音になる)。
        // 代わりに、hook も PTY 出力も長時間途絶えたときだけ作業状態を捨てる。
        const quietFor = now - Math.max(session.hook.lastEventAt, session.lastOutputAt);
        if (quietFor > HOOK_STALE_MS) {
          clearWork(session.hook);
          this.setStatus(session, 'idle');
          this.scheduleActivityPublish(session);
        }
        continue;
      }
      if (now - session.lastBusyAt > BUSY_HOLD_MS) {
        this.setStatus(session, session.claudeDetected ? 'idle' : 'shell');
      }
    }
  }

  private setStatus(session: Session, status: AgentStatus): void {
    if (session.status === status) return;
    session.status = status;
    session.statusSince = Date.now();
    this.broadcast(session, { type: 'status', status });
    broadcastEvent({ type: 'session', session: this.toInfo(session) });
  }

  /** Flushes coalesced 'data' output for a session, cancelling any pending timer. */
  private flush(session: Session): void {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }
    if (session.pending) {
      // PTY 出力はバイナリフレームで流す。JSON だと制御文字のエスケープ (ESC 等) で
      // 膨らみ、クライアントは文字列をパースしてから xterm へ渡すが、バイナリなら
      // xterm が UTF-8 のバイト列を直接受ける (client/src/lib/liveSocket.ts の onBinary)。
      this.broadcastBinary(session, Buffer.from(session.pending, 'utf8'));
      session.pending = '';
    }
  }

  private broadcast(session: Session, msg: object): void {
    const payload = JSON.stringify(msg);
    for (const ws of session.sockets) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }

  private broadcastBinary(session: Session, payload: Buffer): void {
    for (const ws of session.sockets) {
      if (ws.readyState === ws.OPEN) ws.send(payload, { binary: true });
    }
  }

  private toInfo(session: Session): SessionInfo {
    return {
      id: session.id,
      cwd: session.cwd,
      title: session.title,
      kind: 'pty',
      status: session.status,
      claudeDetected: session.claudeDetected,
      createdAt: session.createdAt,
      lastOutputAt: session.lastOutputAt,
      statusSince: session.statusSince,
      activity: session.hook
        ? {
            tool: session.hook.tool ? session.hook.tool.detail : null,
            toolSince: session.hook.tool ? session.hook.tool.since : null,
            subagents: subagentList(session.hook),
            backgroundTask: session.hook.runningBackgroundTask,
          }
        : null,
    };
  }
}

export function normalizePath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export const homeDir = os.homedir();
