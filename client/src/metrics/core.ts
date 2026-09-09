import { Registry } from './registry.js';

/**
 * 計測点が import する最小モジュール。レジストリのシングルトンだけを持ち、重い依存
 * (zustand / monaco / DOM オブザーバー) は index.ts 側に置く — api.ts や store.ts のような
 * 単体テストされるモジュールから import しても、テストが monaco を引き込まないようにするため。
 */
export const metrics = new Registry({
  slowMs: { http: 250, 'xterm.write': 50 },
});

let tileCount = 0;
/** useTileLayout から現在のタイル (leaf) 数を通知する。サンプラーはこれを読むだけ。 */
export function reportTileCount(n: number): void {
  tileCount = n;
}
export function currentTileCount(): number {
  return tileCount;
}
