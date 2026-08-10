import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as pty from 'node-pty';
import type { WebSocket } from 'ws';
import { claudeCommand } from './hooks.js';
import { broadcastEvent, registerSnapshotProvider } from './sessionEvents.js';

export type AgentStatus = 'busy' | 'waiting' | 'idle' | 'shell';

const MAX_SCROLLBACK = 200_000; // chars of raw output kept for reattach
const BUSY_HOLD_MS = 3_000; // spinner redraw gap tolerance
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
  scrollback: string;
  carry: string; // stripped tail carried into the next chunk's pattern scan
  modes: Map<number, boolean>; // last seen state of TRACKED_MODES (true = set/h); unseen modes are absent
  modeCarry: string; // raw tail carried into the next chunk's DECSET_RE scan
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
}

function defaultShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: 'powershell.exe', args: ['-NoLogo'] };
  }
  return { file: process.env.SHELL || 'bash', args: [] };
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
    const proc = pty.spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 32,
      cwd,
      // CLAUDE_DECK_* は deck-hook.mjs がイベントの届け先とセッションを
      // 特定するための変数。claude 経由でフックの子プロセスまで届く。
      env: {
        ...process.env,
        CLAUDE_DECK_PORT: String(this.port),
        CLAUDE_DECK_TERM: id,
      } as Record<string, string>,
    });
    const session: Session = {
      id,
      cwd: path.resolve(cwd),
      title: run ? 'Claude Code' : path.basename(cwd),
      proc,
      scrollback: '',
      carry: '',
      modes: new Map(),
      modeCarry: '',
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
    };
    this.sessions.set(session.id, session);

    proc.onData((data) => this.onData(session, data));
    proc.onExit(() => {
      this.flush(session);
      session.exited = true;
      this.broadcast(session, { type: 'exit' });
      for (const ws of session.sockets) ws.close();
      this.sessions.delete(session.id);
      broadcastEvent({ type: 'removed', id: session.id });
    });

    if (run) {
      // "claude" は hooks 設定つきの完全なコマンドラインに展開する。
      const command = run === 'claude' ? claudeCommand() : run;
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
    // Flush any pending 'data' broadcast to existing sockets BEFORE adding the
    // new one: pending is already folded into scrollback (onData updates both
    // synchronously), so the new socket must receive it only via the snapshot
    // below, never via a live broadcast — otherwise it would see it twice.
    this.flush(session);
    session.sockets.add(ws);
    // Scrollback is trimmed to MAX_SCROLLBACK, so one-shot mode sequences sent
    // at startup (bracketed paste, mouse tracking) can fall out of the window.
    // The client resets the terminal before replaying the snapshot, so without
    // re-asserting the tracked modes here, a reattach silently loses bracketed
    // paste (multi-line pastes submit line-by-line) and mouse tracking (copy
    // selection breaks). Reset ('l') states must be included too: some modes
    // default to on (e.g. 25, cursor visibility), so a tracked "off" has to be
    // re-sent to override the client's post-reset default.
    const prefix = [...session.modes.entries()]
      .sort(([a], [b]) => a - b)
      .map(([mode, on]) => `\x1b[?${mode}${on ? 'h' : 'l'}`)
      .join('');
    ws.send(JSON.stringify({ type: 'snapshot', data: prefix + session.scrollback }));
    ws.send(JSON.stringify({ type: 'status', status: session.status }));
    ws.on('message', (raw) => {
      let msg: { type: string; data?: string; cols?: number; rows?: number };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (session.exited) return;
      if (msg.type === 'input' && typeof msg.data === 'string') {
        // Answering a dialog leaves "waiting"; the next spinner frame promotes
        // to busy again, otherwise the session settles on idle.
        if (session.status === 'waiting') this.setStatus(session, 'idle');
        session.proc.write(msg.data);
      } else if (msg.type === 'resize' && msg.cols && msg.rows) {
        try {
          session.proc.resize(msg.cols, msg.rows);
        } catch {
          // resize can race with exit
        }
      }
    });
    ws.on('close', () => session.sockets.delete(ws));
    return true;
  }

  /**
   * Claude Code の hook イベントを反映する (deck-hook.mjs からの POST)。
   * TUI ヒューリスティックと同じ状態機械に「確度の高い信号」として注入する:
   * 遷移が即時・正確になる一方、hooks が届かないセッションでは従来どおり
   * ヒューリスティックだけで動く。
   */
  applyHookEvent(id: string, event: string, message: string, notificationType: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    switch (event) {
      case 'SessionStart':
        session.claudeDetected = true;
        if (session.status === 'shell') this.setStatus(session, 'idle');
        break;
      case 'UserPromptSubmit':
      case 'PreToolUse':
      case 'PostToolUse':
        session.claudeDetected = true;
        session.lastBusyAt = Date.now();
        this.setStatus(session, 'busy');
        break;
      case 'Notification':
        // ユーザーの判断が必要な通知 (許可要求・質問ダイアログ) のみ waiting。
        // アイドル通知は idle。notification_type が無い旧バージョンは message で判定。
        session.claudeDetected = true;
        if (
          /^(permission_prompt|elicitation_dialog|agent_needs_input)$/.test(notificationType) ||
          (!notificationType && /permission|needs your/i.test(message))
        ) {
          this.setStatus(session, 'waiting');
        } else if (
          notificationType === 'idle_prompt' ||
          (!notificationType && /waiting for .*input|ready for your input/i.test(message))
        ) {
          this.setStatus(session, 'idle');
        }
        break;
      case 'Stop':
        session.claudeDetected = true;
        this.setStatus(session, 'idle');
        break;
      case 'SessionEnd':
        session.claudeDetected = false;
        this.setStatus(session, 'shell');
        break;
      default:
        break;
    }
    return true;
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
    session.scrollback = (session.scrollback + data).slice(-MAX_SCROLLBACK);
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
    if (promptEnd > busyEnd) {
      this.setStatus(session, 'waiting');
    } else if (busyEnd > 0) {
      session.lastBusyAt = Date.now();
      session.claudeDetected = true; // a spinner implies an agent TUI
      this.setStatus(session, 'busy');
    } else if (
      session.claudeDetected &&
      session.status !== 'busy' &&
      SHELL_RETURN_RE.test(scan)
    ) {
      // Claude exited and the shell prompt is back. If this is a false hit
      // (prompt-like text inside Claude output), the footer redraw re-detects.
      session.claudeDetected = false;
      this.setStatus(session, 'shell');
    }

    // Trim past the last match so stale text cannot re-trigger on the next chunk.
    session.carry = scan.slice(Math.max(busyEnd, promptEnd, scan.length - CARRY_MAX));
  }

  private tick(): void {
    for (const session of this.sessions.values()) {
      if (session.status === 'busy' && Date.now() - session.lastBusyAt > BUSY_HOLD_MS) {
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
      this.broadcast(session, { type: 'data', data: session.pending });
      session.pending = '';
    }
  }

  private broadcast(session: Session, msg: object): void {
    const payload = JSON.stringify(msg);
    for (const ws of session.sockets) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
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
    };
  }
}

export function normalizePath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export const homeDir = os.homedir();
