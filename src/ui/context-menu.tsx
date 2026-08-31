import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export type MenuItem =
  | { kind: 'item'; label: string; icon?: ReactNode; danger?: boolean; onSelect: () => void }
  | { kind: 'separator' };

export function ContextMenu({ x, y, items, onClose }: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  // Clamp inside the viewport once rendered.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const bounds = menu.getBoundingClientRect();
    setPosition({
      left: Math.min(x, window.innerWidth - bounds.width - 8),
      top: Math.min(y, window.innerHeight - bounds.height - 8),
    });
  }, [x, y]);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    // Any click outside, scroll, or another context menu closes this one.
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('wheel', close, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('wheel', close);
    };
  }, [onClose]);

  return (
    <div ref={menuRef} className="context-menu" style={{ left: position.left, top: position.top }} role="menu" onPointerDown={(event) => event.stopPropagation()}>
      {items.map((item, index) =>
        item.kind === 'separator' ? (
          <div key={`sep-${index}`} className="menu-separator" role="separator" />
        ) : (
          <button
            key={item.label}
            className={`menu-item${item.danger ? ' danger' : ''}`}
            role="menuitem"
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ),
      )}
    </div>
  );
}
