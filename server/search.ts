import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { rgPath } from '@vscode/ripgrep';

export interface SearchMatch {
  line: number; // 1-based
  column: number; // 1-based, UTF-16 code units (ready for Monaco setPosition)
  preview: string;
  ranges: [number, number][]; // highlight ranges in preview, [start, end) UTF-16
}

export interface SearchFileResult {
  path: string; // root-relative, forward slashes
  matches: SearchMatch[];
}

export interface SearchTextResponse {
  results: SearchFileResult[];
  fileCount: number;
  matchCount: number;
  limitHit: boolean; // capped by maxResults or the timeout
}

export interface SearchOptions {
  regex: boolean;
  caseSensitive: boolean;
  maxResults: number;
  timeoutMs?: number;
}

const PREVIEW_MAX = 300; // chars of a line shown in a result row
const PREVIEW_LEAD = 40; // chars kept before the first match when truncating

// rg --json events (only the fields we consume). `text` is absent when the
// data is not valid UTF-8 — rg sends `bytes` instead and we skip the event.
interface RgMatchEvent {
  type: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
    submatches?: { start: number; end: number }[];
  };
}

/** rg submatch offsets are UTF-8 bytes; convert to UTF-16 code units. */
function byteToChar(buf: Buffer, byteOffset: number): number {
  return buf.toString('utf8', 0, byteOffset).length;
}

function toMatch(lineNumber: number, rawLine: string, submatches: { start: number; end: number }[]): SearchMatch {
  const lineText = rawLine.replace(/\r?\n$/, '');
  const buf = Buffer.from(lineText, 'utf8');
  let ranges: [number, number][] = submatches
    .map(({ start, end }): [number, number] => [
      byteToChar(buf, Math.min(start, buf.length)),
      byteToChar(buf, Math.min(end, buf.length)),
    ])
    .filter(([s, e]) => e > s);
  if (ranges.length === 0) ranges = [[0, 0]];
  const column = ranges[0][0] + 1;

  let preview = lineText;
  if (lineText.length > PREVIEW_MAX) {
    const windowStart = Math.max(0, ranges[0][0] - PREVIEW_LEAD);
    const windowEnd = windowStart + PREVIEW_MAX;
    const prefix = windowStart > 0 ? '…' : '';
    const suffix = windowEnd < lineText.length ? '…' : '';
    preview = prefix + lineText.slice(windowStart, windowEnd) + suffix;
    const shift = prefix.length - windowStart;
    ranges = ranges
      .map(([s, e]): [number, number] => [
        Math.max(prefix.length, s + shift),
        Math.min(prefix.length + PREVIEW_MAX, e + shift),
      ])
      .filter(([s, e]) => e > s);
  }
  return { line: lineNumber, column, preview, ranges: ranges.filter(([s, e]) => e > s) };
}

/**
 * Run ripgrep under `root`. Resolves with grouped results; `cancel()` kills
 * the process and resolves with whatever was parsed so far (the caller is
 * expected to discard it — used when the client aborts the request).
 */
export function searchText(
  root: string,
  query: string,
  opts: SearchOptions,
): { promise: Promise<SearchTextResponse>; cancel: () => void } {
  const args = ['--json', '--hidden', '--glob', '!**/.git/**'];
  if (!opts.caseSensitive) args.push('--ignore-case');
  if (!opts.regex) args.push('--fixed-strings');
  // -e guards against queries starting with '-'; the explicit '.' path (plus
  // stdio[0]='ignore') keeps rg out of stdin-search mode.
  args.push('-e', query, '.');

  // Windows: spawn passes args via CreateProcessW (UTF-16), so non-ASCII
  // queries survive. Never add shell:true — cp932 mangling + injection risk.
  const child = spawn(rgPath, args, {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const byFile = new Map<string, SearchFileResult>();
  let matchCount = 0;
  let limitHit = false;
  let stderr = '';
  let settled = false;

  const kill = () => {
    try {
      child.kill();
    } catch {
      // already dead
    }
  };
  const cancel = () => {
    limitHit = true;
    kill();
  };

  const promise = new Promise<SearchTextResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      limitHit = true;
      kill();
    }, opts.timeoutMs ?? 10_000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 4096) stderr += chunk;
    });

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      if (limitHit) return; // draining after kill
      let event: RgMatchEvent;
      try {
        event = JSON.parse(line) as RgMatchEvent;
      } catch {
        return;
      }
      if (event.type !== 'match') return;
      const data = event.data;
      const rawPath = data?.path?.text;
      const rawLine = data?.lines?.text;
      if (!rawPath || rawLine === undefined || !data?.line_number || !data.submatches) return; // non-UTF-8
      const relPath = rawPath.replace(/^\.[\\/]/, '').replace(/\\/g, '/');
      let file = byFile.get(relPath);
      if (!file) {
        file = { path: relPath, matches: [] };
        byFile.set(relPath, file);
      }
      file.matches.push(toMatch(data.line_number, rawLine, data.submatches));
      matchCount += Math.max(1, data.submatches.length);
      if (matchCount >= opts.maxResults) {
        limitHit = true;
        kill();
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      // exit 0 = matches, 1 = no matches, 2 = error (e.g. a bad regex typed
      // mid-edit). Partial read errors also exit 2 but still yield matches —
      // keep those instead of failing the whole search.
      if (code === 2 && matchCount === 0 && !limitHit) {
        reject(new Error(stderr.trim() || 'ripgrep failed'));
        return;
      }
      resolve({
        results: [...byFile.values()],
        fileCount: byFile.size,
        matchCount,
        limitHit,
      });
    });
  });

  return { promise, cancel };
}
