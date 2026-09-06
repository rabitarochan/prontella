import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import type { VsCodeStatus } from '../types';
import { attachOverlay, detachOverlay, setOverlayVisible } from './vscode/overlayHost';
import { vscodeFolderParam } from './vscode/folderParam';

/**
 * VS Code タイルの中身。ここが描くのは **プレースホルダーだけ**で、
 * iframe 実体は overlayHost が持つ (理由は overlayHost.ts の冒頭コメント)。
 */
export default function VsCodePanel({
  root,
  visible,
}: {
  root: string;
  visible: boolean;
}) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<VsCodeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setStarting(true);
    setError(null);
    api
      .vscodeEnsure()
      .then((s) => {
        if (cancelled) return;
        setStatus(s);
        setError(s.ready ? null : (s.lastError ?? t('vscode.notReady')));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setStarting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, t]);

  const ready = status?.ready === true;

  // 占有の登録。src は初回に決めたら張り替えない (張り替えると再ロードされる)。
  useEffect(() => {
    const el = hostRef.current;
    if (!el || !ready || !status) return;
    const src = `${status.basePath}/?folder=${vscodeFolderParam(root)}`;
    attachOverlay(root, src, el);
    return () => detachOverlay(el);
  }, [ready, status, root]);

  // 表示状態は推測させず明示的に渡す。ビュー切替では VsCodePanel は
  // アンマウントされない (visited パターンで display:none のまま残る) ので、
  // ここで伝えないと iframe が他ビューの上に残り続ける。
  useEffect(() => {
    const el = hostRef.current;
    if (!el || !ready) return;
    setOverlayVisible(el, visible);
  }, [visible, ready]);

  return (
    <div className="vscode-panel">
      <div className="vscode-panel-host" ref={hostRef} />
      {!ready && (
        <div className="vscode-panel-state">
          {starting ? (
            <span className="vscode-panel-msg">{t('vscode.starting')}</span>
          ) : (
            <>
              <span className="vscode-panel-msg vscode-panel-error">
                {error ?? t('vscode.notReady')}
              </span>
              {status && !status.installed && (
                <span className="vscode-panel-hint">{t('vscode.notInstalled')}</span>
              )}
              <button onClick={() => setAttempt((n) => n + 1)}>{t('vscode.retry')}</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
