import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as pty from 'node-pty';
import type { WebSocket } from 'ws';

export type AgentStatus = 'busy' | 'waiting' | 'idle' | 'shell';

const MAX_SCROLLBACK = 200_000; // chars of raw output kept for reattach
const BUSY_HOLD_MS = 3_000; // spinner redraw gap tolerance
const CARRY_MAX = 400; // stripped chars carried over to match across chunk splits

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

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
  status: AgentStatus;
  claudeDetected: boolean;
  createdAt: number;
  lastOutputAt: number;
}

interface Session {
  id: string;
  cwd: string;
  title: string;
  proc: pty.IPty;
  scrollback: string;
  carry: string; // stripped tail carried into the next chunk's pattern scan
  sockets: Set<WebSocket>;
  status: AgentStatus;
  claudeDetected: boolean;
  lastBusyAt: number;
  lastOutputAt: number;
  createdAt: number;
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

  constructor() {
    this.timer = setInterval(() => this.tick(), 1_000);
    this.timer.unref();
  }

  create(cwd: string, run?: 'claude' | string): SessionInfo {
    const shell = defaultShell();
    const proc = pty.spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 32,
      cwd,
      env: { ...process.env } as Record<string, string>,
    });
    const session: Session = {
      id: randomUUID().slice(0, 8),
      cwd: path.resolve(cwd),
      title: run ? 'Claude Code' : path.basename(cwd),
      proc,
      scrollback: '',
      carry: '',
      sockets: new Set(),
      status: 'shell',
      claudeDetected: false,
      lastBusyAt: 0,
      lastOutputAt: Date.now(),
      createdAt: Date.now(),
      exited: false,
    };
    this.sessions.set(session.id, session);

    proc.onData((data) => this.onData(session, data));
    proc.onExit(() => {
      session.exited = true;
      this.broadcast(session, { type: 'exit' });
      for (const ws of session.sockets) ws.close();
      this.sessions.delete(session.id);
    });

    if (run) {
      // Let the shell finish initializing before injecting the command, so it
      // lands on a ready prompt across PowerShell / bash / zsh.
      const eol = '\r';
      setTimeout(() => {
        if (!session.exited) proc.write(run + eol);
      }, process.platform === 'win32' ? 1_200 : 400);
    }
    return this.toInfo(session);
  }

  attach(id: string, ws: WebSocket): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.sockets.add(ws);
    ws.send(JSON.stringify({ type: 'snapshot', data: session.scrollback }));
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
    const sessions = this.list(cwd);
    if (sessions.length === 0) return { status: 'none', terminalId: null };
    const order: AgentStatus[] = ['waiting', 'busy', 'idle', 'shell'];
    for (const status of order) {
      const hit = sessions.find((s) => s.status === status);
      if (hit) return { status, terminalId: hit.id };
    }
    return { status: 'shell', terminalId: sessions[0].id };
  }

  private onData(session: Session, data: string): void {
    session.lastOutputAt = Date.now();
    session.scrollback = (session.scrollback + data).slice(-MAX_SCROLLBACK);
    this.broadcast(session, { type: 'data', data });

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
    this.broadcast(session, { type: 'status', status });
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
      status: session.status,
      claudeDetected: session.claudeDetected,
      createdAt: session.createdAt,
      lastOutputAt: session.lastOutputAt,
    };
  }
}

export function normalizePath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export const homeDir = os.homedir();
