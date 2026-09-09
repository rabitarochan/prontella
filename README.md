# Prontella

A deck for managing Claude Code agents running across multiple Git repositories and multiple worktrees.

There are two ways to start Claude Code, and **both keep using your subscription** (no API key involved):

- **Terminal (term view)**: launched in interactive mode on a PTY (a real terminal) — the usual TUI.
- **Chat (chat view)**: launched through the Claude Agent SDK and driven from a structured chat UI of our own
  (streaming output, tool cards, permission dialogs).
  Authentication is left entirely to your own `claude /login` (subscription OAuth); the deck never touches your credentials.
  If `ANTHROPIC_API_KEY` is set, the SDK prefers it and **you get billed per token**, so the server warns about it at startup.

## Architecture

- **Server** (`server/`): Node.js + Express + ws + node-pty
  - Git operations run the `git` CLI via `execFile` (parsing porcelain output).
  - Terminals are created with node-pty and relayed over WebSocket (`/ws/term?id=`).
  - Chat sessions are created with the Claude Agent SDK (`server/agentSession.ts`) and relayed over WebSocket
    (`/ws/agent?id=`) as structured events (text deltas, tool_use, permission requests). Status comes straight from
    the SDK message stream — no heuristics needed. Permission prompts are resolved by forwarding `canUseTool` to the
    client's permission dialog.
  - Agent status is detected two ways (hooks win; heuristics are the fallback):
    - **Claude Code hooks**: launching via "✦ Start Claude" injects `claude --settings ~/.prontella/hook-settings.json`.
      Each hook event (SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Notification / Stop / SessionEnd)
      is forwarded by `~/.prontella/deck-hook.mjs` to `POST /api/agent-events`. Accurate and immediate, with no
      dependence on TUI wording. (The session is identified by the PTY environment variables `PRONTELLA_PORT` /
      `PRONTELLA_TERM`. Your own hook settings are merged in and keep working.)
    - **TUI heuristics** (fallback for a `claude` you started yourself): PTY output is watched with ANSI stripped.
      - `esc to interrupt` / spinner glyphs → **busy**
      - a permission prompt such as `❯ 1.` → **waiting**
      - spinner quiet for 3 seconds → **idle**
  - Status changes for every session are pushed to clients over WebSocket (`/ws/events`).
- **Client** (`client/`): Vite + React + xterm.js + Zustand
- Settings are stored in `~/.prontella/config.json` (the list of registered repositories).
- Works on Windows / macOS / Linux (the shell is chosen automatically: PowerShell or `$SHELL`).

## Features

- Register repositories and view them as a deck (branch, change count, and agent status for every worktree).
- Add Git worktrees (new or existing branch) and remove them — the default path is `../<repo>.worktrees/<branch>`.
- The worktree view is a VS Code-style tile layout (split, drag to resize, persisted per worktree).
  **Each tile has two levels of tabs**: the tile header switches between Files / Git / Terminal, and state survives switching.
  - **Files**: a file tree (react-arborist + VS Code codicons) plus a Monaco editor with a tab per open file (Ctrl+S to save).
  - **Git**: a three-pane layout — the workspace sidebar and the Staged | Changes lists are always visible, and only the
    side-by-side diff of the file you select opens as a tab.
  - **Terminal**: tabs for the terminals the tile owns (each tab shows an agent status dot). You can split into another
    tile to place terminals side by side.
- **Open in editor**: opens the worktree in your native VS Code, so your real settings, keybindings, and extensions all
  apply. Override the command with `PRONTELLA_EDITOR_CMD` (for VSCodium, Cursor, and so on). The button is hidden when
  no editor is found.
- Git tab: a Sourcetree-like layout — a left sidebar (file status / history / branches / remotes / stashes) plus the main view.
- Side-by-side diffs with the Monaco DiffEditor, stage/unstage (one file or all), discarding changes, and commits (amend supported).
- Fetch / pull / push (pushing adds `-u origin` automatically when no upstream is set).
- Branches tab: list (local and remote), create, switch, delete, and merge (with an abort button during conflicts).
- Stashes (save / apply / pop / drop, including untracked files).
- A Sourcetree-like commit graph (the DAG of all branches drawn in lanes, branch and tag label chips, an `--all` toggle).
- Commit details (the list of changed files plus a diff per file; merge commits diff against their first parent).
- Terminals per worktree (as many as you like) and a "✦ Start Claude" button.
- Live agent status (busy / waiting / idle / shell / not started).
- Notifications: a desktop notification and a chime the moment an agent starts **waiting** or **finishes**.
  The tab title also carries a badge with the waiting count, so you notice it while working in another tab.
- Attention queue: the bell 🔔 in the top bar lists waiting and idle agents with how long they have been that way;
  click one to jump to its worktree. Notifications and sound are toggled from here too.

## Usage

### Run with npx (published build)

```sh
npx prontella            # start the server and open a browser
npx prontella --port 4000 --no-open
```

- Requires Node.js 24+ and git. node-pty ships prebuilt binaries for Windows and macOS, so no build tools are needed
  (only Linux needs gcc and friends).
- Terminal sessions survive closing the browser, as long as the server keeps running.

### From the repository

```sh
npm install

# development (server on :3711, Vite on :8110)
npm run dev          # http://localhost:8110

# production-like (build, then start through the launcher)
npm run build
npm start            # = node bin/prontella.js
```

### Publishing to npm

```sh
npm login
npm publish          # prepublishOnly builds for you
```

Register a repository path with the "+" in the sidebar and cards appear on the deck.
Open a worktree and hit "✦ Start Claude" to launch Claude Code with that directory as the working directory.

## Notes

- The server listens on `127.0.0.1` only. It writes files and owns PTYs, so do not expose it.
- Terminals and chat sessions run in **the same environment you would get from a freshly opened terminal**, not in the
  environment of the shell that started the deck (on Windows it is rebuilt from the Machine and User environment
  variables; on macOS/Linux it is read from a login shell). This way the deck behaves the same no matter which terminal
  you start it from, and the deck's own variables such as `NODE_ENV` or `PORT` never leak in. To pass a variable to
  terminals, set it as an OS user environment variable rather than exporting it in your shell.
- On Windows the terminal is `pwsh` (PowerShell 7 or later) when available, otherwise `powershell.exe`
  (Windows PowerShell 5.1). The PSReadLine bundled with 5.1 is 2.0.0 and has no Predictive IntelliSense, which is why
  the default leans toward PowerShell 7. To pick one explicitly, set `PRONTELLA_SHELL` to a command name or an absolute
  path (for example `PRONTELLA_SHELL=powershell.exe`). If it cannot be found, the deck warns and falls back to the default.
- On Windows the terminal uses **the newer ConPTY that ships with node-pty** (the Windows Terminal 1.23 line) rather than
  the one bundled with the OS. The OS version is the older generation that renders a child's VT into a screen buffer and
  then re-renders it; the newer one passes VT straight through. Measured, scrolling a large amount of output is about
  1.5x faster and time-to-first-byte is 5-7x shorter (reproduce it with `node scripts/bench/conpty-ab.mjs`). If anything
  breaks, `PRONTELLA_CONPTY_DLL=0` goes back to the OS ConPTY. If loading fails, the deck warns and falls back automatically.
- **Metrics are off by default and never leave your machine.** Performance metrics can be collected in two tiers:
  `anon` (no paths, repository or branch names, session titles, prompts, or user/host names; every string must match a
  closed vocabulary or the record is dropped) and `dev` (verbose, for working on Prontella itself). Turn `anon` on from
  the command palette ("Diagnostics: enable anonymous metrics"), or set `PRONTELLA_METRICS=anon|dev|off` (the variable
  locks the setting). Records are JSONL under `~/.prontella/metrics/<tier>/`, capped at 20 MB (anon) / 200 MB (dev).
  `node scripts/metrics/summarize.mjs --tier dev` renders a Markdown report (slow operations, memory trend, hangs,
  wasted work); "Diagnostics: download anonymous metrics bundle" (or `node scripts/metrics/export.mjs`) produces a
  gzip you can attach to a bug report. In the `dev` tier, `POST /api/metrics/heap-snapshot` writes a V8 heap snapshot.
- `scripts/ws-debug.mjs` is a helper for debugging terminal output and status detection.
- `scripts/term-size-probe.js` collects diagnostics when a terminal renders smaller than its frame (paste it into the
  browser console; it only reads).
- A `claude` started any other way (typed into a terminal, say) has no hooks, so it is detected by TUI wording heuristics
  alone. If a wording change hurts accuracy, adjust `BUSY_RE` / `PROMPT_RE` in `server/pty.ts`. To get hook-based
  detection for a manual launch, start it with `claude --settings ~/.prontella/hook-settings.json`.
- Desktop notifications need to be allowed once, from the bell 🔔 dropdown (the browser asks for permission).
