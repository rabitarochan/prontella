import fs from 'node:fs';
import path from 'node:path';

/**
 * JSONL シンク。
 *
 * - `write()` はキューに積むだけ (ホットパスから呼ばれても I/O しない)
 * - flush はタイマー (既定 2 秒) で 1 回の `appendFile`。常設ストリームは持たない —
 *   利用者がファイルを消した/ローテートしたときにハンドルで掴んだままにならないため
 *   (Windows の EPERM 事情は server/config.ts の writeJsonAtomic を参照)
 * - flush は single-flight。前回の append が終わる前に次の flush 時刻が来たら合流させる
 * - バックプレッシャー: キューが上限を超えたら**最古を捨てて** `dropped` を数える。詰まらせない
 * - ローテート: 1 ファイルが maxFileBytes を超えたら `-N` を付けた次のファイルへ。日付が変われば新ファイル
 * - ディレクトリー上限: 起動時と 1 時間ごとに古いファイルから消す (現在のファイルは消さない)
 * - `close()` は残りを同期 append する (process 'exit' から呼べる)
 *
 * ファイル名は `YYYY-MM-DD.<pid>.jsonl` — Windows で使えない `:` を含めず、同じホームで
 * 2 プロセス (本番 + bench) が並走しても衝突しない。
 */

export interface SinkStats {
  written: number;
  dropped: number;
  bytes: number;
  flushErrors: number;
  file: string | null;
}

export interface Sink {
  write(line: string): void;
  flush(): Promise<void>;
  close(): void;
  stats(): SinkStats;
  readonly dir: string;
}

export interface SinkOptions {
  dir: string;
  maxFileBytes?: number;
  maxDirBytes?: number;
  flushMs?: number;
  maxQueue?: number;
  /** テスト用: 現在時刻 (ファイル名の日付)。 */
  now?: () => number;
  pid?: number;
}

const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;
const DEFAULT_FLUSH_MS = 2_000;
const DEFAULT_MAX_QUEUE = 2_000;
const DIR_CAP_INTERVAL_MS = 60 * 60 * 1000;

function dateStamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function createJsonlSink(opts: SinkOptions): Sink {
  const dir = opts.dir;
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxDirBytes = opts.maxDirBytes ?? Infinity;
  const flushMs = opts.flushMs ?? DEFAULT_FLUSH_MS;
  const maxQueue = opts.maxQueue ?? DEFAULT_MAX_QUEUE;
  const now = opts.now ?? Date.now;
  const pid = opts.pid ?? process.pid;

  let queue: string[] = [];
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  let flushAgain = false;
  let closed = false;
  let dirReady = false;
  let lastDirCapAt = 0;

  let currentDate = '';
  let rotation = 0;
  let currentFile: string | null = null;
  let currentSize = 0;

  const stats: SinkStats = { written: 0, dropped: 0, bytes: 0, flushErrors: 0, file: null };

  function fileFor(date: string, index: number): string {
    return path.join(dir, index === 0 ? `${date}.${pid}.jsonl` : `${date}.${pid}-${index}.jsonl`);
  }

  function ensureDir(): void {
    if (dirReady) return;
    fs.mkdirSync(dir, { recursive: true });
    dirReady = true;
  }

  /**
   * 書き込み先を決める。日付が変わったら 0 から、サイズ超過なら次の番号へ。
   * 既存ファイル (再起動・同日) はサイズを引き継ぎ、すでに上限を超えていれば最初から次へ進む。
   */
  function pickFile(): string {
    const date = dateStamp(now());
    if (date !== currentDate) {
      currentDate = date;
      rotation = 0;
      currentFile = null;
    }
    for (;;) {
      if (!currentFile) {
        currentFile = fileFor(currentDate, rotation);
        try {
          currentSize = fs.statSync(currentFile).size;
        } catch {
          currentSize = 0;
        }
        stats.file = currentFile;
      }
      if (currentSize < maxFileBytes) return currentFile;
      rotation += 1;
      currentFile = null;
    }
  }

  function enforceDirCap(): void {
    if (!Number.isFinite(maxDirBytes)) return;
    const t = now();
    if (t - lastDirCapAt < DIR_CAP_INTERVAL_MS) return;
    lastDirCapAt = t;
    let entries: { file: string; size: number }[];
    try {
      entries = fs
        .readdirSync(dir)
        .filter((name) => name.endsWith('.jsonl'))
        .map((name) => {
          const file = path.join(dir, name);
          try {
            return { file, size: fs.statSync(file).size };
          } catch {
            return { file, size: 0 };
          }
        })
        .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    } catch {
      return;
    }
    let total = entries.reduce((sum, e) => sum + e.size, 0);
    for (const entry of entries) {
      if (total <= maxDirBytes) break;
      if (entry.file === currentFile) continue;
      try {
        fs.unlinkSync(entry.file);
        total -= entry.size;
      } catch {
        // 消せなくても続ける (他プロセスが開いている等)
      }
    }
  }

  function takeBatch(): { data: string; lines: number } | null {
    if (queue.length === 0) return null;
    const lines = queue;
    queue = [];
    return { data: lines.join('\n') + '\n', lines: lines.length };
  }

  async function doFlush(): Promise<void> {
    const batch = takeBatch();
    if (!batch) return;
    try {
      ensureDir();
      const file = pickFile();
      await fs.promises.appendFile(file, batch.data, 'utf8');
      const bytes = Buffer.byteLength(batch.data, 'utf8');
      currentSize += bytes;
      stats.written += batch.lines;
      stats.bytes += bytes;
      enforceDirCap();
    } catch {
      stats.flushErrors += 1;
      stats.dropped += batch.lines;
    }
  }

  function flush(): Promise<void> {
    if (inFlight) {
      flushAgain = true;
      return inFlight;
    }
    inFlight = doFlush().finally(() => {
      inFlight = null;
      if (flushAgain) {
        flushAgain = false;
        if (queue.length > 0) void flush();
      }
    });
    return inFlight;
  }

  function schedule(): void {
    if (timer || closed) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, flushMs);
    timer.unref();
  }

  return {
    dir,
    write(line: string): void {
      if (closed) return;
      if (queue.length >= maxQueue) {
        queue.shift();
        stats.dropped += 1;
      }
      queue.push(line);
      schedule();
    },
    flush,
    close(): void {
      if (closed) return;
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const batch = takeBatch();
      if (!batch) return;
      try {
        ensureDir();
        const file = pickFile();
        fs.appendFileSync(file, batch.data, 'utf8');
        stats.written += batch.lines;
        stats.bytes += Buffer.byteLength(batch.data, 'utf8');
      } catch {
        stats.flushErrors += 1;
        stats.dropped += batch.lines;
      }
    },
    stats: () => ({ ...stats }),
  };
}
