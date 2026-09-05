#!/usr/bin/env node
/**
 * conpty-ab.mjs — Windows の ConPTY 2 世代の生スループット A/B。
 *
 * node-pty は Windows Terminal 由来の conpty.dll を同梱しており、`useConptyDll: true`
 * で OS 同梱 (in-box) の ConPTY の代わりに使える。in-box は子プロセスの VT を一度
 * 画面バッファに起こして再レンダリングする旧世代、同梱版は VT を素通しする新世代。
 *
 * term-bench.mjs (フルハーネス) はブラウザーまで含むぶんノイズが大きく、ConPTY 単体の
 * 差を見るには向かない。こちらは PTY とシェルだけを回して「素のスクロール」を測る。
 *
 *   node scripts/bench/conpty-ab.mjs --rounds 5 --lines 50000
 *
 * 判定は絶対値ではなく **方向の一貫性** で行う (このマシンは他作業で CPU が張り付き、
 * 同じコードでも wall が倍近くぶれる)。各ラウンドの生値も出すので、全ラウンドで同じ側が
 * 速いかどうかを見ること。ラウンドごとに A/B の実行順を入れ替えてドリフトを相殺する。
 *
 * 併せて kill 経路も検証する: useConptyDll では node-pty が
 * conpty_console_list_agent によるコンソールプロセス一括 kill を行わず、
 * conpty.dll 側の後始末に任せる (lib/windowsPtyAgent.js:133-180)。シェルが孤児として
 * 残らないか、kill 後に pid の生存を確認する。
 */
import * as ptyNs from 'node-pty';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

// node-pty は CJS。Node ESM からの名前付き import は環境によって壊れるので default 経由で取る。
const pty = ptyNs.default ?? ptyNs;

/**
 * 同期用トークン。2 つの罠を同時に避ける必要がある:
 *
 * 1. シェルは打ち込んだコマンド行をエコーバックする。JS 側で連結した完成形を書くと、
 *    エコーが即座にトークンに一致して「出力完了」を誤検知する (実測: 50000 行のはずが
 *    3KB で完了したことになった)。**連結はシェル側で行う**。
 * 2. PSReadLine は履歴からインライン予測を描画する。過去に汚染された履歴が残っていると
 *    そこにトークンが現れうるので、**実行ごとにランダムなタグ**を付けて履歴と衝突させない。
 */
function makeTokens() {
  const tag = randomBytes(4).toString('hex').toUpperCase();
  return {
    // シェルに書く式 (連結前) / 出力に現れる値 (連結後)
    readyExpr: `"RD" + "Y_${tag}"`,
    readyToken: `RDY_${tag}`,
    doneExpr: `"DN" + "E_${tag}"`,
    doneToken: `DNE_${tag}`,
  };
}

// 計測対象は ConPTY のスループットであって PowerShell のパイプラインではない。
// `1..50000 | ForEach-Object { ... }` を直接流すと 1 行あたり 300us の pwsh 側コストが
// 支配的になり (実測: 50000 行で 15 秒)、ConPTY の差が 1.1x に埋もれる。
// そこで **文字列を先に組み立ててから 1 回で吐き出す**。組み立ては計測外。
const CASES = {
  plain: {
    label: 'plain scroll',
    line: '"line $_ ........................................"',
  },
  unicode: {
    label: 'unicode/日本語',
    line: '"行 $_ 日本語のテキストを含む行 ～ αβγ ✻ ..............."',
  },
};

function parseArgs(argv) {
  const out = { rounds: 5, lines: 50000, cases: ['plain', 'unicode'], shell: null, timeout: 120_000, noDa1: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} には値が必要です`);
      return v;
    };
    if (a === '--rounds') out.rounds = Number(next());
    else if (a === '--lines') out.lines = Number(next());
    else if (a === '--shell') out.shell = next();
    else if (a === '--timeout') out.timeout = Number(next());
    else if (a === '--no-da1') out.noDa1 = true;
    else if (a === '--case') {
      const v = next();
      out.cases = v === 'both' ? ['plain', 'unicode'] : v.split(',');
    } else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`不明なオプション: ${a}`);
  }
  for (const c of out.cases) if (!CASES[c]) throw new Error(`不明な --case: ${c}`);
  if (!Number.isInteger(out.rounds) || out.rounds < 1) throw new Error('--rounds は 1 以上の整数');
  if (!Number.isInteger(out.lines) || out.lines < 1) throw new Error('--lines は 1 以上の整数');
  return out;
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 1 回分の計測。シェルを起こして READY を待ち、固定ワークを流して DONE までの
 * 壁時計時間・受信バイト数・onData 回数を測り、kill して pid の生存を見る。
 */
async function runOnce({ useConptyDll, lines, caseKey, shell, timeout, noDa1 }) {
  const file = shell ?? 'pwsh.exe';
  const tokens = makeTokens();
  const spawnedAt = performance.now();
  const proc = pty.spawn(file, ['-NoLogo', '-NoProfile'], {
    name: 'xterm-256color',
    cols: 120,
    rows: 32,
    cwd: process.cwd(),
    env: process.env,
    ...(useConptyDll ? { useConptyDll: true } : {}),
  });

  let buf = '';
  let bytes = 0;
  let chunks = 0;
  let firstDataAt = 0;
  let measuring = false;
  let resolveWait = null;
  let waitToken = null;

  // server/pty.ts と同じ DA1 応答。これを返さないと ConPTY v2 は端末の返事を約 3 秒
  // 待ってから進むので、起動時間の比較が「タイムアウト待ちの比較」になってしまう。
  // --no-da1 で無効化すると、その 3 秒がそのまま観測できる。
  let da1Answered = false;
  proc.onData((data) => {
    if (!noDa1 && !da1Answered && data.includes('\x1b[c')) {
      da1Answered = true;
      proc.write('\x1b[?1;2c');
    }
    if (measuring) {
      if (!firstDataAt) firstDataAt = performance.now();
      bytes += Buffer.byteLength(data, 'utf8');
      chunks++;
    }
    buf += data;
    if (buf.length > 1 << 16) buf = buf.slice(-4096); // トークン照合に要るぶんだけ残す
    if (waitToken && buf.includes(waitToken)) settle();
  });

  let exited = false;
  const settle = (fn) => {
    const done = resolveWait;
    waitToken = null;
    resolveWait = null;
    done?.(fn);
  };
  proc.onExit(() => {
    exited = true;
    settle(new Error('シェルが計測中に終了しました'));
  });

  const waitFor = (token) =>
    new Promise((resolve, reject) => {
      const finish = (err) => {
        clearTimeout(t);
        if (err) reject(err);
        else resolve();
      };
      const t = setTimeout(
        () => settle(new Error(`タイムアウト: ${token} が ${timeout}ms 以内に現れませんでした`)),
        timeout,
      );
      if (buf.includes(token)) return finish();
      waitToken = token;
      resolveWait = finish;
    });

  try {
    // 起動完了待ち。プロンプトの見た目に依存しないようトークンで同期する。
    // spawn からここまでが「タブを開いてから打てるようになるまで」の体感時間。
    proc.write(`${tokens.readyExpr}\r`);
    await waitFor(tokens.readyToken);
    if (exited) throw new Error('シェルが計測前に終了しました');
    const startupMs = performance.now() - spawnedAt;
    buf = '';

    // 1. ペイロードの組み立て (計測外)。改行込みの 1 本の文字列にする。
    const line = CASES[caseKey].line;
    const prepTokens = makeTokens();
    proc.write(
      `$p = -join (1..${lines} | ForEach-Object { ${line} + "\`r\`n" }); ${prepTokens.doneExpr}\r`,
    );
    await waitFor(prepTokens.doneToken);
    if (exited) throw new Error('シェルがペイロード組み立て中に終了しました');
    buf = '';

    // 2. 1 回の Write で吐き出す。ここだけを測る = ConPTY のスループット。
    measuring = true;
    const start = performance.now();
    proc.write(`[Console]::Out.Write($p); ${tokens.doneExpr}\r`);
    await waitFor(tokens.doneToken);
    const ms = performance.now() - start;
    measuring = false;

    const pid = proc.pid;
    proc.kill();
    // conpty.dll 側の後始末は非同期。少し待ってから生存を見る。
    await sleep(1_500);
    return {
      startupMs,
      ms,
      ttfbMs: firstDataAt ? firstDataAt - start : null,
      bytes,
      chunks,
      pid,
      orphan: isAlive(pid),
    };
  } catch (err) {
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
    throw err;
  }
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function fmt(n, digits = 1) {
  return Number.isFinite(n) ? n.toFixed(digits) : '-';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      [
        'node scripts/bench/conpty-ab.mjs [options]',
        '  --rounds <n>   ラウンド数 (既定 5)',
        '  --lines <n>    1 回あたりの出力行数 (既定 50000)',
        `  --case <c>     ${Object.keys(CASES).join(' | ')} | both (既定 both)`,
        '  --shell <path> シェル (既定 pwsh.exe)',
        '  --timeout <ms> 1 回あたりの上限 (既定 120000)',
        '  --no-da1       DA1 に応答しない (ConPTY v2 の起動待ち 3 秒を観測する)',
      ].join('\n'),
    );
    return;
  }
  if (process.platform !== 'win32') {
    console.error('このスクリプトは Windows 専用です (ConPTY の A/B)。');
    process.exitCode = 1;
    return;
  }

  console.log(
    `conpty A/B: rounds=${args.rounds} lines=${args.lines} cases=${args.cases.join(',')} ` +
      `shell=${args.shell ?? 'pwsh.exe'}`,
  );
  console.log(`node-pty: ${path.basename(process.cwd())} の node_modules を使用\n`);

  const results = {}; // caseKey -> { inbox: [], dll: [] }
  const orphans = { inbox: 0, dll: 0 };

  for (const caseKey of args.cases) {
    results[caseKey] = { inbox: [], dll: [] };
    for (let round = 0; round < args.rounds; round++) {
      // ラウンドごとに順序を入れ替え、マシン負荷のドリフトが片側に偏らないようにする。
      const order = round % 2 === 0 ? ['dll', 'inbox'] : ['inbox', 'dll'];
      for (const mode of order) {
        const r = await runOnce({
          useConptyDll: mode === 'dll',
          lines: args.lines,
          caseKey,
          shell: args.shell,
          timeout: args.timeout,
          noDa1: args.noDa1,
        });
        results[caseKey][mode].push(r);
        if (r.orphan) orphans[mode]++;
        console.log(
          `  [${caseKey}] round ${round + 1} ${mode.padEnd(5)} ` +
            `startup ${fmt(r.startupMs, 0)}ms  scroll ${fmt(r.ms)}ms  ttfb ${fmt(r.ttfbMs)}ms  ` +
            `${(r.bytes / 1024).toFixed(0)}KB / ${r.chunks} chunks` +
            (r.orphan ? '  ** ORPHAN **' : ''),
        );
      }
    }
    console.log('');
  }

  console.log('| case | metric | in-box ConPTY | 同梱 conpty.dll | 比 |');
  console.log('| --- | --- | --- | --- | --- |');
  for (const caseKey of args.cases) {
    const { inbox, dll } = results[caseKey];
    const rows = [
      ['startup ms (median)', median(inbox.map((r) => r.startupMs)), median(dll.map((r) => r.startupMs)), 0],
      ['scroll ms (median)', median(inbox.map((r) => r.ms)), median(dll.map((r) => r.ms)), 1],
      ['ttfb ms (median)', median(inbox.map((r) => r.ttfbMs ?? NaN)), median(dll.map((r) => r.ttfbMs ?? NaN)), 1],
      ['bytes KB (median)', median(inbox.map((r) => r.bytes / 1024)), median(dll.map((r) => r.bytes / 1024)), 0],
      ['chunks (median)', median(inbox.map((r) => r.chunks)), median(dll.map((r) => r.chunks)), 0],
    ];
    for (const [name, a, b, d] of rows) {
      const ratio = b ? a / b : NaN;
      console.log(
        `| ${CASES[caseKey].label} | ${name} | ${fmt(a, d)} | ${fmt(b, d)} | ${fmt(ratio, 2)}x |`,
      );
    }
  }

  // 方向の一貫性: 各ラウンドで dll 側が速かった回数。
  console.log('');
  for (const caseKey of args.cases) {
    const { inbox, dll } = results[caseKey];
    const wins = dll.filter((r, i) => r.ms < inbox[i].ms).length;
    console.log(
      `${CASES[caseKey].label}: 同梱 conpty.dll が速かったラウンド ${wins}/${dll.length}`,
    );
  }
  console.log(
    `孤児シェル (kill 後も生存): in-box ${orphans.inbox} 件 / 同梱 conpty.dll ${orphans.dll} 件`,
  );
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
