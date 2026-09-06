// VSCodium reh-web (Web Host) の取得。
//
// npm に同梱しない: 圧縮 108MB / 展開 345MB あり、全ユーザーと全 CI に
// その負担を強いるうえ OS/arch ごとに別パッケージが要る。初回利用時に落とす。
//
// 実測にもとづく前提 (2026-09-06):
// - バージョン解決の JSON は **Windows だけ `/system/` が挟まる**
//     stable/win32/x64/system/latest.json → 200
//     stable/win32/x64/latest.json        → 404
//     stable/linux/x64/latest.json        → 200 (darwin も同様)
// - リリース資産と `.sha256` サイドカーは linux/win32/darwin の x64/arm64 いずれも存在する
// - GitHub のダウンロードは別ホストへ 302 する (fetch は既定で追う)
// - アーカイブはラッパーディレクトリーを持たず、直下に bin/ out/ node.exe が並ぶ
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const VERSIONS_BASE = 'https://raw.githubusercontent.com/VSCodium/versions/refs/heads/master/stable';
const RELEASE_BASE = 'https://github.com/VSCodium/vscodium/releases/download';

export type InstallPhase = 'resolving' | 'downloading' | 'verifying' | 'extracting';

export interface InstallProgress {
  phase: InstallPhase;
  version: string | null;
  /** 受信済みバイト数 (downloading 以外では 0)。 */
  received: number;
  /** 全体バイト数。Content-Length が無ければ null。 */
  total: number | null;
}

export interface Target {
  /** VSCodium のリリース資産で使われる OS 名。 */
  os: 'win32' | 'linux' | 'darwin';
  arch: 'x64' | 'arm64' | 'armhf';
}

/** 実行中の Node からダウンロード対象を決める。未対応なら null。 */
export function currentTarget(): Target | null {
  const os =
    process.platform === 'win32'
      ? 'win32'
      : process.platform === 'darwin'
        ? 'darwin'
        : process.platform === 'linux'
          ? 'linux'
          : null;
  if (!os) return null;
  const arch =
    process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch === 'arm' ? 'armhf' : null;
  if (!arch) return null;
  // armhf の reh-web は linux にしかない
  if (arch === 'armhf' && os !== 'linux') return null;
  return { os, arch };
}

/** 最新版の名前 (`1.126.04524` 形式) を解決する。 */
export async function resolveLatestVersion(target: Target): Promise<string> {
  // Windows のみ `/system/` を挟む (実測。挟まないと 404)
  const suffix = target.os === 'win32' ? `${target.os}/${target.arch}/system` : `${target.os}/${target.arch}`;
  const url = `${VERSIONS_BASE}/${suffix}/latest.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`VSCodium のバージョン解決に失敗しました (${res.status}): ${url}`);
  const json = (await res.json()) as { name?: unknown };
  if (typeof json.name !== 'string' || !json.name) {
    throw new Error(`VSCodium のバージョン解決に失敗しました (name が無い): ${url}`);
  }
  return json.name;
}

function assetName(target: Target, version: string): string {
  return `vscodium-reh-web-${target.os}-${target.arch}-${version}.tar.gz`;
}

/** `<hex>  <filename>` 形式のサイドカーから期待ハッシュを取り出す。 */
async function fetchExpectedSha256(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`sha256 サイドカーを取得できません (${res.status}): ${url}`);
  const text = await res.text();
  const hex = /^([0-9a-f]{64})\b/i.exec(text.trim());
  if (!hex) throw new Error(`sha256 サイドカーの形式が想定と違います: ${url}`);
  return hex[1].toLowerCase();
}

/**
 * `tar` の実体。Windows では **System32 の bsdtar を優先**する。
 * PATH 上の tar が Git 同梱の GNU tar だと `-f C:/...` の `C:` を
 * リモートホスト指定と解釈しうるため (下の cwd 併用でも回避しているが、
 * 素直に bsdtar を使う方が確実)。
 */
function tarBin(): string {
  if (process.platform === 'win32') {
    const sys = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(sys)) return sys;
  }
  return 'tar';
}

/**
 * reh-web を `<root>/<version>/` に用意する。既にあれば何もしない。
 * 途中で失敗しても中途半端な `<version>/` を残さないよう、
 * 一時ディレクトリーへ展開してから rename する。
 */
export async function installVsCodium(
  root: string,
  onProgress: (p: InstallProgress) => void,
  signal?: AbortSignal,
): Promise<string> {
  const target = currentTarget();
  if (!target) {
    throw new Error(`VSCodium の配布が無いプラットフォームです: ${process.platform}/${process.arch}`);
  }

  onProgress({ phase: 'resolving', version: null, received: 0, total: null });
  const version = await resolveLatestVersion(target);
  const dest = path.join(root, version);
  if (fs.existsSync(path.join(dest, 'out', 'server-main.js'))) return dest;

  fs.mkdirSync(root, { recursive: true });
  // 前回の中断で残った作業ディレクトリーを掃除する (resolveInstall は
  // `.` 始まりを無視するので実害は無いが、放置すると容量を食う)
  for (const entry of fs.readdirSync(root)) {
    if (entry.startsWith('.tmp-')) fs.rmSync(path.join(root, entry), { recursive: true, force: true });
  }

  const name = assetName(target, version);
  const archive = path.join(root, `.tmp-${version}-${process.pid}.tar.gz`);
  const staging = path.join(root, `.tmp-${version}-${process.pid}`);

  try {
    // --- ダウンロード (ハッシュを同時に計算する。2 度読みしない) ---
    const res = await fetch(`${RELEASE_BASE}/${version}/${name}`, { signal });
    if (!res.ok || !res.body) {
      throw new Error(`VSCodium のダウンロードに失敗しました (${res.status}): ${name}`);
    }
    const total = Number(res.headers.get('content-length')) || null;
    const hash = createHash('sha256');
    let received = 0;
    let lastReport = 0;
    await pipeline(
      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      async function* (source) {
        for await (const chunk of source) {
          const buf = chunk as Buffer;
          hash.update(buf);
          received += buf.length;
          // 進捗の報告は間引く (毎チャンク報告すると status がノイズになる)
          const now = Date.now();
          if (now - lastReport > 200) {
            lastReport = now;
            onProgress({ phase: 'downloading', version, received, total });
          }
          yield buf;
        }
      },
      fs.createWriteStream(archive),
      { signal },
    );
    onProgress({ phase: 'downloading', version, received, total });

    // --- 検証 ---
    onProgress({ phase: 'verifying', version, received, total });
    const expected = await fetchExpectedSha256(`${RELEASE_BASE}/${version}/${name}.sha256`);
    const actual = hash.digest('hex');
    if (actual !== expected) {
      throw new Error(`VSCodium のダウンロードが壊れています (sha256 不一致): ${name}`);
    }

    // --- 展開 ---
    // アーカイブ名は相対 + cwd で渡す。絶対パスを -f に渡すと GNU tar が
    // `C:` をホスト指定と解釈する余地があるため。
    onProgress({ phase: 'extracting', version, received, total });
    fs.mkdirSync(staging, { recursive: true });
    await execFileAsync(tarBin(), ['-xzf', path.basename(archive), '-C', staging], {
      cwd: root,
      windowsHide: true,
      // 345MB の展開。既定の 10 分では足りない環境がありうる
      timeout: 20 * 60_000,
    });
    if (!fs.existsSync(path.join(staging, 'out', 'server-main.js'))) {
      throw new Error('展開した VSCodium に out/server-main.js がありません (アーカイブの構成が変わった?)');
    }

    // --- 公開 (ここで初めて resolveInstall から見える) ---
    try {
      fs.renameSync(staging, dest);
    } catch (err) {
      // 併走した別プロセスが先に置いた場合はそれを使う
      if (fs.existsSync(path.join(dest, 'out', 'server-main.js'))) {
        fs.rmSync(staging, { recursive: true, force: true });
      } else {
        throw err;
      }
    }
    return dest;
  } finally {
    fs.rmSync(archive, { force: true });
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
