import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export interface ContextMenuItem {
  label: string;
  icon?: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
}

/**
 * 座標 (x, y) に開く右クリックメニュー。呼び出し側が座標と items を渡して
 * 条件レンダリングする既存 API のまま、内部を shadcn DropdownMenu に置き換えた。
 * 見えないトリガーを fixed 配置してアンカーにする(Radix が viewport 衝突回避・
 * Esc / 外側クリックでの閉じ・キーボードナビを担う)。
 */
export default function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  return (
    <DropdownMenu open onOpenChange={(open) => !open && onClose()}>
      <DropdownMenuTrigger asChild>
        <span aria-hidden style={{ position: 'fixed', left: x, top: y, width: 0, height: 0 }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        // 右クリック元 (ターミナル / ツリー) からフォーカスを奪い返さない
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {items.map((item, i) => (
          <DropdownMenuItem
            key={i}
            disabled={item.disabled}
            variant={item.danger ? 'destructive' : 'default'}
            onSelect={() => item.onClick()}
          >
            {item.icon && <span className={`codicon codicon-${item.icon}`} />}
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
