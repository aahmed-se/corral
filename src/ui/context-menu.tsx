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
    // Containment check, not stopPropagation: this capture listener runs at
    // the window before any bubble handler on the menu could stop it, so a
    // pointerdown on a menu item would otherwise unmount the menu before its
    // click event ever fires.
    const closeIfOutside = (event: Event) => {
      if (menuRef.current && event.composedPath().includes(menuRef.current)) return;
      onClose();
    };
    const close = () => onClose();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    // Any click outside, scroll, or window blur closes the menu.
    window.addEventListener('pointerdown', closeIfOutside, true);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('wheel', closeIfOutside, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', closeIfOutside, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('wheel', closeIfOutside);
    };
  }, [onClose]);

  return (
    <div ref={menuRef} className="context-menu" style={{ left: position.left, top: position.top }} role="menu">
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
