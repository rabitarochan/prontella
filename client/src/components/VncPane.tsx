import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import type RFB from '@novnc/novnc';
import { useT } from '../i18n';
import { useVncPane } from '../layout/vncPaneStore';
import { classifyDisconnect, type VncPhase } from '../vncState';

interface VncStatus {
  host: string;
  port: number;
  reachable: boolean;
}

interface DisconnectMessage {
  key: 'vnc.authFailed' | 'vnc.disconnected' | 'vnc.connectFailed';
  reason: string;
}

/**
 * ホスト端末を noVNC で操作する右ペイン。App 直下 (WorktreeView の key remount の外)
 * に置くことで、worktree 切替・タイル再構成をまたいで RFB 接続が生存する。
 * 閉じるときは unmount せず display:none で保持する (App 側の visited 参照)。
 *
 * 接続はユーザー操作起点のみ (自動接続しない)。VNC サーバー未起動が常態のユーザーで
 * 無駄打ちを避け、StrictMode の dev 二重マウントによる connect/disconnect の
 * 二重発火も構造的に回避する。
 */
export default function VncPane() {
  const t = useT();
  const open = useVncPane((s) => s.open);
  const width = useVncPane((s) => s.width);
  const setOpen = useVncPane((s) => s.setOpen);
  const setWidth = useVncPane((s) => s.setWidth);

  const [phase, setPhase] = useState<VncPhase>('idle');
  const [status, setStatus] = useState<VncStatus | null>(null);
  const [message, setMessage] = useState<DisconnectMessage | null>(null);
  const [viewOnly, setViewOnly] = useState(false);
  const [password, setPassword] = useState('');

  const screenRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const everConnectedRef = useRef(false);
  const securityReasonRef = useRef<string | null>(null);
  // ユーザーの切断ボタン / unmount 起点の切断では「切断されました」を出さず idle へ戻す
  const manualCloseRef = useRef(false);

  const probe = async (): Promise<VncStatus | null> => {
    try {
      const res = await fetch('/api/vnc/status');
      if (!res.ok) return null;
      const data = (await res.json()) as VncStatus;
      setStatus(data);
      return data;
    } catch {
      return null;
    }
  };

  // ペインを開いたとき、未接続なら到達性を取り直して idle ⇄ unreachable を出し分ける
  useEffect(() => {
    if (!open) return;
    if (phase !== 'idle' && phase !== 'unreachable') return;
    void probe().then((s) => {
      if (!s) return;
      setPhase(s.reachable ? 'idle' : 'unreachable');
    });
    // phase を依存に入れると接続失敗のたびに再プローブが走るため open のみで発火する
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const connect = async (): Promise<void> => {
    const el = screenRef.current;
    if (rfbRef.current || !el) return;
    setMessage(null);
    setPhase('connecting');
    everConnectedRef.current = false;
    securityReasonRef.current = null;
    manualCloseRef.current = false;

    // noVNC は接続時のみ動的 import する (Vite が自動でチャンク分割し初期バンドルに乗らない)
    const { default: RFBClass } = await import('@novnc/novnc');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const rfb = new RFBClass(el, `${proto}://${location.host}/ws/vnc`, { shared: true });
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.viewOnly = viewOnly;

    rfb.addEventListener('connect', () => {
      everConnectedRef.current = true;
      setPhase('connected');
    });
    rfb.addEventListener('credentialsrequired', () => {
      setPhase('credentials');
    });
    rfb.addEventListener('securityfailure', (e) => {
      securityReasonRef.current = e.detail.reason ?? `status ${e.detail.status}`;
    });
    rfb.addEventListener('disconnect', () => {
      rfbRef.current = null;
      if (manualCloseRef.current) {
        setPhase('idle');
        return;
      }
      // WS close code は RFB イベントに載らないため、到達性を取り直して分類する
      void probe().then((s) => {
        const result = classifyDisconnect({
          everConnected: everConnectedRef.current,
          securityReason: securityReasonRef.current,
          probeReachable: s ? s.reachable : null,
        });
        setPhase(result.phase);
        setMessage(
          result.messageKey
            ? { key: result.messageKey, reason: securityReasonRef.current ?? '' }
            : null,
        );
      });
    });
    rfbRef.current = rfb;
  };

  const disconnect = (): void => {
    manualCloseRef.current = true;
    rfbRef.current?.disconnect();
  };

  const submitPassword = (): void => {
    // sendCredentials の再送では認証失敗から復帰できないケースがあるため、
    // 失敗時は disconnect イベント経由で RFB を作り直すリトライ経路に乗せる
    rfbRef.current?.sendCredentials({ username: '', password, target: '' });
    setPassword(''); // 資格情報を state に残さない
    setPhase('connecting');
  };

  // viewOnly は接続中の RFB へ即時反映
  useEffect(() => {
    if (rfbRef.current) rfbRef.current.viewOnly = viewOnly;
  }, [viewOnly]);

  // display:none 中はコンテナーが 0 サイズでスケール計算が壊れる。再表示・リサイズの
  // たびに scaleViewport を再代入して再スケールをトリガーする (setter が再計算する)。
  useEffect(() => {
    const el = screenRef.current;
    if (!el) return;
    const rescale = () => {
      if (el.offsetWidth > 0 && el.offsetHeight > 0 && rfbRef.current) {
        rfbRef.current.scaleViewport = true;
      }
    };
    if (open) rescale();
    const observer = new ResizeObserver(rescale);
    observer.observe(el);
    return () => observer.disconnect();
  }, [open]);

  // unmount 時 (通常は起きない — App が display:none で保持する) の後始末
  useEffect(() => {
    return () => {
      manualCloseRef.current = true;
      rfbRef.current?.disconnect();
      rfbRef.current = null;
    };
  }, []);

  const startResize = (e: ReactMouseEvent): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    const onMove = (ev: MouseEvent) => {
      // 右ペインなので左へドラッグ = 拡大
      setWidth(startW + (startX - ev.clientX));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const hostLabel = status ? { host: status.host, port: status.port } : { host: '…', port: '' };

  return (
    <aside className="vnc-pane" style={{ width, display: open ? undefined : 'none' }}>
      <div className="vnc-resize-handle" onMouseDown={startResize} />
      <div className="vnc-pane-inner">
        <header className="vnc-pane-header">
          <span className="codicon codicon-vm" />
          <span className="vnc-pane-title">{t('vnc.title')}</span>
          <span className="vnc-pane-actions">
            {phase === 'connected' && (
              <>
                <button
                  className={`icon-btn${viewOnly ? ' vnc-btn-active' : ''}`}
                  title={t('vnc.viewOnly')}
                  onClick={() => setViewOnly((v) => !v)}
                >
                  <span className="codicon codicon-eye" />
                </button>
                <button
                  className="icon-btn"
                  title={t('vnc.ctrlAltDel')}
                  onClick={() => rfbRef.current?.sendCtrlAltDel()}
                >
                  <span className="codicon codicon-keyboard" />
                </button>
                <button className="icon-btn" title={t('vnc.disconnect')} onClick={disconnect}>
                  <span className="codicon codicon-debug-disconnect" />
                </button>
              </>
            )}
            <button className="icon-btn" title={t('common.close')} onClick={() => setOpen(false)}>
              <span className="codicon codicon-close" />
            </button>
          </span>
        </header>
        <div className="vnc-screen-wrap">
          <div ref={screenRef} className="vnc-screen" />
          {phase !== 'connected' && (
            <div className="vnc-overlay">
              {phase === 'idle' && (
                <>
                  <p className="vnc-overlay-text">
                    {status
                      ? t('vnc.idleHint', hostLabel)
                      : t('vnc.checking')}
                  </p>
                  <button className="vnc-btn" onClick={() => void connect()}>
                    {t('vnc.connect')}
                  </button>
                </>
              )}
              {phase === 'connecting' && (
                <p className="vnc-overlay-text">{t('vnc.connecting')}</p>
              )}
              {phase === 'credentials' && (
                <form
                  className="vnc-credentials"
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitPassword();
                  }}
                >
                  <p className="vnc-overlay-text">{t('vnc.passwordTitle')}</p>
                  <input
                    type="password"
                    className="vnc-password-input"
                    placeholder={t('vnc.passwordPlaceholder')}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoFocus
                  />
                  <button className="vnc-btn" type="submit">
                    {t('vnc.passwordSubmit')}
                  </button>
                </form>
              )}
              {phase === 'disconnected' && (
                <>
                  <p className="vnc-overlay-text">
                    {message ? t(message.key, { reason: message.reason }) : t('vnc.disconnected')}
                  </p>
                  <button className="vnc-btn" onClick={() => void connect()}>
                    {t('vnc.reconnect')}
                  </button>
                </>
              )}
              {phase === 'unreachable' && (
                <div className="vnc-guide">
                  <p className="vnc-overlay-text vnc-guide-title">{t('vnc.unreachableTitle')}</p>
                  <p className="vnc-guide-body">{t('vnc.unreachableBody', hostLabel)}</p>
                  <p className="vnc-guide-section">{t('vnc.setupGuideTitle')}</p>
                  <ul className="vnc-guide-list">
                    <li>{t('vnc.setupWindows')}</li>
                    <li>{t('vnc.setupMac')}</li>
                    <li>{t('vnc.setupLinux')}</li>
                  </ul>
                  <p className="vnc-guide-hint">{t('vnc.configHint')}</p>
                  <button
                    className="vnc-btn"
                    onClick={() =>
                      void probe().then((s) => {
                        if (s?.reachable) setPhase('idle');
                      })
                    }
                  >
                    {t('vnc.retryProbe')}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
