/**
 * タブ id: 8 桁 16 進の乱数。sessionStorage に置く (タブ単位・リロードで維持・localStorage には
 * 置かない)。何からも導出しない — 個人やマシンを識別する値ではなく、同じタブの記録を
 * 集計時に束ねるためだけの鍵。
 */

const KEY = 'prontella.metrics.tab';
const ID_RE = /^[0-9a-f]{8}$/;

function randomId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

let cached: string | null = null;

export function tabId(): string {
  if (cached) return cached;
  let id: string | null = null;
  try {
    id = sessionStorage.getItem(KEY);
  } catch {
    // sessionStorage が使えない (プライベートモード等) — 乱数を持つだけ
  }
  if (!id || !ID_RE.test(id)) {
    id = randomId();
    try {
      sessionStorage.setItem(KEY, id);
    } catch {
      // 保存できなくても続行
    }
  }
  cached = id;
  return id;
}
