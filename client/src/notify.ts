// デスクトップ通知 (Notification API) と WebAudio チャイム。
// 音声ファイルを持たず、オシレーターだけで完結させる。

let audioCtx: AudioContext | null = null;

function ctx(): AudioContext | null {
  try {
    audioCtx ??= new AudioContext();
    return audioCtx;
  } catch {
    return null;
  }
}

/** 短いチャイム。waiting は上昇 2 音 (注意喚起)、done は柔らかい 1 音。 */
export function chime(kind: 'waiting' | 'done'): void {
  const ac = ctx();
  if (!ac) return;
  // 一度もページ操作がないタブでは autoplay 制限で resume が拒否される。
  // その場合は黙って諦める (デスクトップ通知側は生きている)。
  ac.resume()
    .then(() => {
      const notes = kind === 'waiting' ? [880, 1174.7] : [659.3];
      notes.forEach((freq, i) => {
        const t0 = ac.currentTime + i * 0.16;
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(kind === 'waiting' ? 0.12 : 0.06, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
        osc.connect(gain).connect(ac.destination);
        // stop() alone leaves the node graph connected forever (the AudioContext itself
        // is reused across calls per `ctx()`'s comment, so nothing else ever tears this
        // down) — disconnect both nodes once the oscillator actually finishes.
        osc.onended = () => {
          osc.disconnect();
          gain.disconnect();
        };
        osc.start(t0);
        osc.stop(t0 + 0.55);
      });
    })
    .catch(() => {});
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  return 'Notification' in window ? Notification.permission : 'unsupported';
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  try {
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

/** デスクトップ通知。クリックでこのタブにフォーカスして onClick を実行する。 */
export function desktopNotify(title: string, body: string, tag: string, onClick?: () => void): void {
  if (notificationPermission() !== 'granted') return;
  try {
    const n = new Notification(title, { body, tag });
    n.onclick = () => {
      window.focus();
      onClick?.();
      n.close();
    };
  } catch {
    // 一部環境はコンストラクター呼び出し自体が投げる (Android Chrome など)
  }
}
