import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import type { VsCodeStatus } from '../types';
import { attachOverlay, detachOverlay, setOverlayVisible } from './vscode/overlayHost';
import { vscodeFolderParam } from './vscode/folderParam';

/** 準備中に status を追う間隔。ダウンロードの進捗表示がカクつかない程度。 */
const POLL_MS = 500;

function formatMB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

/**
 * VS Code タイルの中身。ここが描くのは **プレースホルダーだけ**で、
 * iframe 実体は overlayHost が持つ (理由は overlayHost.ts の冒頭コメント)。
 *
 * 初回は VSCodium 本体 (圧縮 108MB) のダウンロードが走る。サーバーの ensure は
 * 待たずに着手だけするので、ここで status をポーリングして進捗を出す。
 */
export default function VsCodePanel({ root, visible }: { root: string; visible: boolean }) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<VsCodeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const step = (s: VsCodeStatus) => {
      if (cancelled) return;
      setStatus(s);
      setError(s.lastError);
      // ready でも準備中でもないのに lastError も無い = 起動に失敗して静かに
      // 終わった状態。追い続けても意味がないので止める。
      if (s.ready || (!s.preparing && s.lastError)) return;
      timer = setTimeout(poll, POLL_MS);
    };

    const poll = () => {
      api
        .vscodeStatus()
        .then(step)
        .catch((e: unknown) => {
          if (cancelled) return;
          setError(e instanceof Error ? e.message : String(e));
        });
    };

    setError(null);
    api
      .vscodeEnsure()
      .then(step)
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      });

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [attempt]);

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
          {error ? (
            <>
              <span className="vscode-panel-msg vscode-panel-error">{error}</span>
              <button onClick={() => setAttempt((n) => n + 1)}>{t('vscode.retry')}</button>
            </>
          ) : (
            <Progress status={status} />
          )}
        </div>
      )}
    </div>
  );
}

function Progress({ status }: { status: VsCodeStatus | null }) {
  const t = useT();
  const install = status?.install ?? null;
  if (!install) return <span className="vscode-panel-msg">{t('vscode.starting')}</span>;

  if (install.phase === 'downloading') {
    const pct = install.total ? Math.floor((install.received / install.total) * 100) : null;
    return (
      <>
        <span className="vscode-panel-msg">
          {t('vscode.downloading')}
          {install.version ? ` (${install.version})` : ''}
        </span>
        <span className="vscode-panel-hint">
          {formatMB(install.received)}
          {install.total ? ` / ${formatMB(install.total)}` : ''} MB
          {pct !== null ? ` — ${pct}%` : ''}
        </span>
        {pct !== null && (
          <span className="vscode-progress">
            <span className="vscode-progress-bar" style={{ width: `${pct}%` }} />
          </span>
        )}
        <span className="vscode-panel-hint">{t('vscode.downloadNote')}</span>
      </>
    );
  }
  const key =
    install.phase === 'resolving'
      ? 'vscode.resolving'
      : install.phase === 'verifying'
        ? 'vscode.verifying'
        : 'vscode.extracting';
  return <span className="vscode-panel-msg">{t(key)}</span>;
}
