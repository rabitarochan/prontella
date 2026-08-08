import { useCallback, useRef, useState, type ReactNode } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface ConfirmRequest {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 'danger' は破壊的操作 (discard / force delete 等) 用の赤い確認ボタンにする */
  severity?: 'normal' | 'danger';
}

/** shadcn AlertDialog ベースの汎用確認ダイアログ。Radix が body へポータルするため、
 *  タイルの container-type に閉じ込められる問題 (旧実装のコメント参照) は構造的に起きない。 */
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
  const actionRef = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog open onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent
        // Radix の既定はキャンセル側フォーカスだが、既存 UX は「Enter で実行」なので
        // 実行ボタンへフォーカスを移す
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          actionRef.current?.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
        </AlertDialogHeader>
        {/* message は ReactNode (ブロック要素を含み得る) のため Description(<p>) は使わない */}
        <div className="text-muted-foreground text-sm">{message}</div>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            ref={actionRef}
            className={cn(severity === 'danger' && buttonVariants({ variant: 'destructive' }))}
            onClick={onConfirm}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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
