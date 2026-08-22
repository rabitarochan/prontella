// @novnc/novnc 1.7 は package.json の exports がルート "." → core/rfb.js のみで、
// 型パッケージ @types/novnc__novnc (1.6 系) は旧レイアウトの
// "@novnc/novnc/lib/rfb" しか宣言していない。実体を型に合わせて 1.6 に下げるのではなく、
// ルートパスを型宣言側へブリッジする (バージョンスキューの吸収はこの 1 ファイルに閉じる)。
declare module '@novnc/novnc' {
  import RFB from '@novnc/novnc/lib/rfb';
  export default RFB;
}
