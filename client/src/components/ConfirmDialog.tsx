import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface ConfirmRequest {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 'danger' は破壊的操作 (discard / force delete 等) 用の赤い確認ボタンにする */
  severity?: 'normal' | 'danger';
}

/** AddWorktreeModal と同じ modal-backdrop / modal パターンの汎用確認ダイアログ。 */
export default function ConfirmDialog({
  title,
  message,
  confirmLabel = '実行',
  cancelLabel = 'キャンセル',
  severity = 'normal',
  onConfirm,
  onCancel,
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  severity?: 'normal' | 'danger';
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  // .modal-backdrop は position:fixed だが、.tile-pane に container: tile / inline-size
  // (styles.css:1418) が付いており container-type は fixed 要素の包含ブロックを作る。
  // そのためタイル内 (ポータルホスト .tile-host { position:absolute; inset:0; overflow:hidden })
  // から描画するとダイアログがタイルに閉じ込められ、width:460px 固定の .modal は狭いタイルで
  // クリップされてボタンが押せなくなる。body へポータルしてビューポート全面に戻す。
  return createPortal(
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal confirm-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <div className="confirm-message">{message}</div>
        <div className="modal-actions">
          <button onClick={onCancel}>{cancelLabel}</button>
          <button
            className={severity === 'danger' ? 'danger' : 'primary'}
            autoFocus
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Promise ベースの確認ダイアログフック。
 * `const { confirm, dialog } = useConfirm()` として使い、`await confirm({ title, message })` が
 * ユーザーの選択 (true = 実行 / false = キャンセル) を返す。`{dialog}` を JSX 内に置くだけでよい。
 */
export function useConfirm() {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const resolver = useRef<((result: boolean) => void) | null>(null);

  const confirm = useCallback((req: ConfirmRequest) => {
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setRequest(req);
    });
  }, []);

  const settle = useCallback((result: boolean) => {
    resolver.current?.(result);
    resolver.current = null;
    setRequest(null);
  }, []);

  const dialog = request ? (
    <ConfirmDialog
      title={request.title}
      message={request.message}
      confirmLabel={request.confirmLabel}
      cancelLabel={request.cancelLabel}
      severity={request.severity}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  ) : null;

  return { confirm, dialog };
}
