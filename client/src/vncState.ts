// VNC ペインの状態判定ロジック。UI (VncPane.tsx) は vitest の対象外 (*.test.ts のみ)
// のため、テストで守れる判定部分をここに切り出す。

/** VNC ペインの表示状態。 */
export type VncPhase =
  | 'idle' // 未接続 (接続ボタン待ち)
  | 'connecting' // RFB ハンドシェイク中
  | 'credentials' // パスワード入力待ち
  | 'connected' // 接続確立
  | 'disconnected' // 切断 (理由メッセージ付き)
  | 'unreachable'; // VNC サーバーへ到達不能 (セットアップガイド表示)

export interface DisconnectInput {
  /** この RFB インスタンスで一度でも connect イベントに到達したか。 */
  everConnected: boolean;
  /** securityfailure イベントの reason (認証失敗等)。無ければ null。 */
  securityReason: string | null;
  /** 切断後に取り直した /api/vnc/status の reachable (取得失敗・未取得は null)。 */
  probeReachable: boolean | null;
}

export interface DisconnectResult {
  phase: 'disconnected' | 'unreachable';
  /** i18n キー。unreachable のときはガイド画面自体が説明するため null。 */
  messageKey: 'vnc.authFailed' | 'vnc.disconnected' | 'vnc.connectFailed' | null;
}

/**
 * RFB の disconnect イベント後にどの画面へ遷移するかの判定。
 * noVNC は WebSocket close code をイベントに載せないため、securityfailure の有無・
 * 接続到達の有無・到達性プローブの再取得結果から分類する。
 */
export function classifyDisconnect(input: DisconnectInput): DisconnectResult {
  if (input.securityReason !== null) {
    // 認証失敗。RFB は閉じているので再試行は RFB の作り直しになる
    return { phase: 'disconnected', messageKey: 'vnc.authFailed' };
  }
  if (input.everConnected) {
    return { phase: 'disconnected', messageKey: 'vnc.disconnected' };
  }
  if (input.probeReachable === false) {
    // 一度も繋がらず、プローブでも到達不能 → VNC サーバー未起動 (ガイド表示)
    return { phase: 'unreachable', messageKey: null };
  }
  // 到達はできるのにハンドシェイクで落ちた (プロトコル不一致等)、またはプローブ失敗
  return { phase: 'disconnected', messageKey: 'vnc.connectFailed' };
}

/** ペイン幅の永続値の検証つき復元。不正値・範囲外は既定値へ。 */
export function sanitizePaneWidth(raw: unknown, fallback = 560): number {
  // Number('') は 0 になるため、空文字列は明示的に不正扱いする
  const n =
    typeof raw === 'string'
      ? raw.trim() === ''
        ? NaN
        : Number(raw)
      : typeof raw === 'number'
        ? raw
        : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), 320), 2000);
}
