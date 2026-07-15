import { useEffect, useLayoutEffect, useRef } from 'react';

export interface ContextMenuItem {
  label: string;
  icon?: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
}

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
  const ref = useRef<HTMLDivElement>(null);

  // 外側クリック・Escape・スクロールで閉じる (EditorStatusBar のメニューと同じパターン)
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // scroll はバブリングしないため capture フェーズで拾う
    const onScroll = () => onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [onClose]);

  // viewport からはみ出す場合は内側に収まるようクランプする
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const clampedX = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4));
    const clampedY = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4));
    el.style.left = `${clampedX}px`;
    el.style.top = `${clampedY}px`;
  }, [x, y]);

  return (
    <div className="context-menu" ref={ref} style={{ left: x, top: y }}>
      {items.map((item, i) => (
        <button
          key={i}
          className={`context-menu-item ${item.danger ? 'danger' : ''}`}
          disabled={item.disabled}
          onClick={() => {
            item.onClick();
            onClose();
          }}
        >
          {item.icon && <span className={`codicon codicon-${item.icon}`} />}
          {item.label}
        </button>
      ))}
    </div>
  );
}
