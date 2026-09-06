/**
 * ワークツリーのパスを workbench の `?folder=` クエリ値に変換する。
 *
 * 形式は先頭スラッシュ + POSIX 区切り + **小文字のドライブレター**。
 * workbench 側 (src/vs/code/browser/workbench/workbench.ts) は
 * `/` 始まりの値を vscode-remote のパスとして扱い、それ以外は完全な URI として解釈する。
 * ドライブレターを小文字にするのは、uri.ts が fsPath を導出するときに小文字化するため
 * (大文字のままだと同じフォルダーが別 URI として扱われうる)。
 *
 * 例: `C:\Users\x\proj` → `/c%3A/Users/x/proj`
 */
export function vscodeFolderParam(p: string): string {
  const posix = p.replace(/\\/g, '/');
  // Windows のドライブレター (`C:/...` または既に `/C:/...`)
  const drive = /^\/?([A-Za-z]):(\/.*)?$/.exec(posix);
  if (drive) {
    const rest = drive[2] ?? '/';
    return `/${drive[1].toLowerCase()}%3A${encodePath(rest)}`;
  }
  return encodePath(posix.startsWith('/') ? posix : `/${posix}`);
}

/** 区切りの `/` は残したままセグメントだけ符号化する。 */
function encodePath(p: string): string {
  return p
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}
