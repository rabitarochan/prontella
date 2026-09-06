// ワークツリーをネイティブのエディター (既定は VS Code) で開く。
//
// なぜ埋め込みではなくネイティブなのか:
// ブラウザーに入れる限り超えられない壁が 2 つある (どちらも実測)。
//   1. ブラウザーがキーバインドを奪う。F5 はページ再読み込みになり、
//      Ctrl+W / Ctrl+N / Ctrl+T も同様。回避手段が無い。
//   2. web workbench のユーザー設定とキーバインドは**ブラウザーの IndexedDB**
//      に入り、デスクトップのプロファイルとは繋がらない。VS Code 側も
//      as-designed (microsoft/vscode#202404)、サーバー保存の要望 #210775 は
//      out-of-scope でクローズ済み。Settings Sync も出荷ビルドの serve-web では
//      無効 (配信設定に sync 関連が無いことを実測で確認)。
// ネイティブに渡せば、設定もキーバインドも拡張機能も本物のまま何も失わない。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { childEnv, envGet, windowsExecutableCandidates } from './childEnv.js';

/** 起動コマンドの上書き。フルパスでも PATH 上の名前でもよい。 */
const OVERRIDE_ENV = 'PRONTELLA_EDITOR_CMD';

export interface EditorLaunchTarget {
  /** 起動する実行ファイル。 */
  exe: string;
  /** 実行ファイルより前に渡す引数 (フォルダーパスはこの後ろに付く)。 */
  args: string[];
}

/** PATH を辿って実行ファイルを探す。無ければ null。 */
function findOnPath(exe: string): string | null {
  const env = childEnv();
  if (process.platform !== 'win32') {
    // POSIX は PATH 解決を spawn に任せてよい (シェルを介さないので名前のままでよい)
    return exe;
  }
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

/**
 * Windows で `code.cmd` を掴んだら、その隣にある本体 `..\Code.exe` へ寄せる。
 *
 * Node は CVE-2024-27980 の対策以降、shell 無しでの .cmd/.bat 起動を拒否する
 * (spawn EINVAL。実測)。shell を挟むとパスのクォート事故を招くので、
 * `code.cmd` が起動しているネイティブ実体を直接叩く
 * (実測: `Code.exe <folder>` でそのフォルダーのウィンドウが開く)。
 */
function nativeAppFor(exe: string): string {
  if (process.platform !== 'win32') return exe;
  const lower = exe.toLowerCase();
  if (!lower.endsWith('.cmd') && !lower.endsWith('.bat')) return exe;
  // bin/code.cmd → ../Code.exe (VS Code / VSCodium / Cursor 等 同じ配置)
  const parent = path.dirname(path.dirname(exe));
  for (const name of ['Code.exe', 'VSCodium.exe', 'Code - Insiders.exe']) {
    const candidate = path.join(parent, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return exe;
}

/**
 * 起動対象を解決する。見つからなければ null。
 * 優先順: PRONTELLA_EDITOR_CMD > PATH 上の `code`。
 */
export function resolveEditor(): EditorLaunchTarget | null {
  const override = process.env[OVERRIDE_ENV];
  if (override) {
    // フルパス指定ならそのまま、名前なら PATH から探す
    const direct = path.isAbsolute(override) && fs.existsSync(override) ? override : findOnPath(override);
    if (!direct) return null;
    return { exe: nativeAppFor(direct), args: [] };
  }
  if (process.platform === 'darwin') {
    // macOS は .app を開く。`code` が PATH に無い環境でも動くよう open 経由にする
    const cli = findOnPath('code');
    if (cli && fs.existsSync(cli)) return { exe: cli, args: [] };
    return { exe: 'open', args: ['-a', 'Visual Studio Code'] };
  }
  const cli = findOnPath('code');
  if (!cli) return null;
  return { exe: nativeAppFor(cli), args: [] };
}

/**
 * 指定ディレクトリーをネイティブエディターで開く。
 *
 * `dir` は呼び出し側で「登録済みリポジトリー / ワークツリーのパス」に限定してから
 * 渡すこと。ここは shell を介さない spawn なので引数インジェクションの余地は無いが、
 * 任意のパスを開ける口を外に出さないため。
 * fire-and-forget — GUI アプリなので終了を待たないし、終了コードも見ない
 * (files.ts の reveal と同じ流儀)。
 */
export function launchEditor(dir: string): void {
  const target = resolveEditor();
  if (!target) {
    throw new Error(
      `エディターが見つかりません。PATH に \`code\` を通すか、${OVERRIDE_ENV} で実行ファイルを指定してください。`,
    );
  }
  const child = spawn(target.exe, [...target.args, dir], {
    detached: true,
    stdio: 'ignore',
    env: childEnv(),
    windowsHide: false,
  });
  child.on('error', () => {}); // ENOENT 等でサーバーを巻き込まない
  child.unref();
}
