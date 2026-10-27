import { describe, expect, it } from 'vitest';
import { panelId } from './SplitPanel';

// react-resizable-panels は layout を `{ [panelId]: pct }` で持ち、Object.values の並びを
// panels 配列の添字に対応させる。正準整数キー ("57412659") は挿入順を無視して先頭へ
// 来るため、そのままの id を渡すとドラッグが逆方向に動く (実機 2026-10-20)。
describe('panelId', () => {
  it('keeps layout key order equal to insertion order even for digit-only ids', () => {
    const top = '91804dff';
    const bottom = '57412659';
    // 素の id だと数値キーが先頭へ繰り上がる (バグの機序そのもの)
    expect(Object.keys({ [top]: 1, [bottom]: 2 })).toEqual([bottom, top]);
    expect(Object.keys({ [panelId(top)]: 1, [panelId(bottom)]: 2 })).toEqual([panelId(top), panelId(bottom)]);
  });
});
