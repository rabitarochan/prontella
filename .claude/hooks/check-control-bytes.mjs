#!/usr/bin/env node
// PostToolUse hook: flag illegal C0 control bytes written into text source files.
//
// Why this exists: in a single session, two builders independently wrote stray C0
// bytes into .ts files -- one into a string literal meant to be empty, one into a
// regex literal meant to express a control-character range. Both passed
// `tsc --noEmit` AND `vitest run`: the bytes are invisible in every diff view and
// only a byte-level scan finds them. (This very file was written with one on the
// first attempt, and this hook caught it.) The Bash tool has a control-character
// guard; Write/Edit do not. This closes that gap.
//
// Allowed C0: 0x09 (tab), 0x0A (LF), 0x0D (CR). Everything else below 0x20, plus
// 0x7F (DEL), is reported.

import { readFileSync } from 'node:fs';

const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|css|scss|html|md|ya?ml|txt|toml|svg)$/i;

function isIllegal(c) {
  return c < 0x09 || c === 0x0b || c === 0x0c || (c >= 0x0e && c <= 0x1f) || c === 0x7f;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let file;
  try {
    const j = JSON.parse(raw || '{}');
    file = j.tool_response?.filePath ?? j.tool_input?.file_path;
  } catch {
    process.exit(0); // malformed payload is not this hook's problem
  }
  if (!file || !TEXT_EXT.test(file)) process.exit(0);

  let buf;
  try {
    buf = readFileSync(file);
  } catch {
    process.exit(0); // deleted/moved/unreadable -- nothing to assert
  }

  const hits = [];
  let line = 1;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c === 0x0a) line++;
    else if (isIllegal(c)) {
      hits.push(`line ${line}, byte ${i}: 0x${c.toString(16).padStart(2, '0')}`);
      if (hits.length >= 10) break;
    }
  }
  if (hits.length === 0) process.exit(0);

  const detail = `${file}\n  ` + hits.join('\n  ');
  process.stdout.write(
    JSON.stringify({
      systemMessage: `Illegal control bytes written into ${file} (${hits.length} found)`,
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          `Illegal C0 control bytes were just written into a text source file. These are ` +
          `invisible in diffs and pass both typecheck and vitest -- they must be removed now.\n` +
          `${detail}\n` +
          `Rewrite the affected span. When the code legitimately needs to handle control ` +
          `characters, compare by code point (e.g. c <= 0x20) instead of embedding raw bytes ` +
          `in a regex or string literal.`,
      },
    }),
  );
  process.exit(0);
});
