/**
 * テキストをクリップボードへコピーする。navigator.clipboard は secure context
 * (https / localhost) 限定なので、LAN の http アクセス(スマホ等)では undefined になる。
 * その場合は textarea + execCommand('copy') にフォールバックする(deprecated だが
 * non-secure context で動く唯一の手段)。成否を boolean で返す。
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 権限拒否等 — フォールバックへ
    }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(ta);
  }
}
