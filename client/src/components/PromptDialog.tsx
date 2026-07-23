import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

export interface PromptRequest {
  title: string;
  message?: ReactNode;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

/** ConfirmDialog と同じ modal-backdrop / modal パターンの汎用 1 行テキスト入力ダイアログ。 */
export default function PromptDialog({
  title,
  message,
  defaultValue = '',
  placeholder,
  confirmLabel = '実行',
  cancelLabel = 'キャンセル',
  onConfirm,
  onCancel,
}: {
  title: string;
  message?: ReactNode;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  // 初期値をハイライト選択した状態でフォーカス (rename 等、上書き入力しやすいように)
  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal confirm-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {message && <div className="confirm-message">{message}</div>}
        <div className="modal-row">
          <input
            ref={inputRef}
            value={value}
            placeholder={placeholder}
            autoFocus
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
          />
        </div>
        <div className="modal-actions">
          <button onClick={onCancel}>{cancelLabel}</button>
          <button className="primary" disabled={!value.trim()} onClick={submit}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Promise ベースの入力ダイアログフック (useConfirm と同じ形)。
 * `const { prompt, dialog } = usePrompt()` として使い、`await prompt({ title, ... })` が
 * 入力値 (キャンセル時は null) を返す。`{dialog}` を JSX 内に置くだけでよい。
 */
export function usePrompt() {
  const [request, setRequest] = useState<PromptRequest | null>(null);
  const resolver = useRef<((result: string | null) => void) | null>(null);
  // 連続 prompt() (例: リモート追加の name→URL 2 段プロンプト) 用の連番。
  // settle() の setRequest(null) と、await 復帰後の次の setRequest(req) が
  // React 18 の自動バッチングで同一コミットにまとまると、`request` は
  // null を経由せず旧 req から新 req へ直接遷移する。その場合 <PromptDialog> は
  // (型・位置が同じ、key なしのため) unmount されず fiber を再利用してしまい、
  // 内部の useState(defaultValue) が再初期化されず前段の入力値が残留する
  // (実機で確認された不具合)。key にこの連番を渡し、request が変わるたびに
  // 強制的に別インスタンスとして remount させることで、バッチングの有無に
  // 関わらず defaultValue を毎回正しく反映させる。
  const requestId = useRef(0);

  const prompt = useCallback((req: PromptRequest) => {
    return new Promise<string | null>((resolve) => {
      resolver.current = resolve;
      requestId.current += 1;
      setRequest(req);
    });
  }, []);

  const settle = useCallback((result: string | null) => {
    resolver.current?.(result);
    resolver.current = null;
    setRequest(null);
  }, []);

  const dialog = request ? (
    <PromptDialog
      key={requestId.current}
      title={request.title}
      message={request.message}
      defaultValue={request.defaultValue}
      placeholder={request.placeholder}
      confirmLabel={request.confirmLabel}
      cancelLabel={request.cancelLabel}
      onConfirm={(v) => settle(v)}
      onCancel={() => settle(null)}
    />
  ) : null;

  return { prompt, dialog };
}
