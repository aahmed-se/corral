import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export type MenuItem =
  /** `hint` is a right-aligned micro-label, e.g. the scope an action applies to. */
  | { kind: 'item'; label: string; hint?: string; icon?: ReactNode; danger?: boolean; onSelect: () => void }
  | { kind: 'separator' };

export function ContextMenu({ x, y, items, onClose }: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const priorFocusRef = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [position, setPosition] = useState({ left: x, top: y });

  // Clamp inside the viewport once rendered.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const bounds = menu.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8)),
    });
  }, [x, y, items]);

  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    // Containment check, not stopPropagation: this capture listener runs at
    // the window before any bubble handler on the menu could stop it, so a
    // pointerdown on a menu item would otherwise unmount the menu before its
    // click event ever fires.
    const closeIfOutside = (event: Event) => {
      if (menuRef.current && event.composedPath().includes(menuRef.current)) return;
      closeRef.current();
    };
    const close = () => closeRef.current();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Tab') closeRef.current();
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
      priorFocusRef.current?.focus();
    };
  }, []);

  const moveFocus = (direction: 1 | -1) => {
    const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    if (buttons.length === 0) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(current + direction + buttons.length) % buttons.length]?.focus();
  };

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: position.left, top: position.top }}
      role="menu"
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown') { event.preventDefault(); moveFocus(1); }
        if (event.key === 'ArrowUp') { event.preventDefault(); moveFocus(-1); }
        if (event.key === 'Home') {
          event.preventDefault();
          menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
        }
        if (event.key === 'End') {
          event.preventDefault();
          const buttons = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
          const last = buttons?.item((buttons?.length ?? 0) - 1);
          last?.focus();
        }
      }}
    >
      {items.map((item, index) =>
        item.kind === 'separator' ? (
          <div key={`sep-${index}`} className="menu-separator" role="separator" />
        ) : (
          <button
            key={item.label}
            className={`menu-item${item.danger ? ' danger' : ''}`}
            role="menuitem"
            onClick={() => {
              closeRef.current();
              item.onSelect();
            }}
          >
            {item.icon}
            <span>{item.label}</span>
            {item.hint && <span className="menu-hint">{item.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}
