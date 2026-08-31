import { useCallback, useEffect, useRef, useState } from 'react';

// Pointer-based drag and drop, built for scale: the payload is a list of ids
// (dragging 50k selected rows costs the same as dragging one), targets are
// found by hit-testing `data-drop-folder` elements under the pointer, and a
// ghost chip follows the pointer instead of any per-row drag imagery.
//
// HTML5 drag-and-drop is deliberately not used — it cannot style the drag
// image reliably, fights with virtualized lists, and offers no control over
// auto-scroll or spring-loaded folder expansion.

export type DragState = {
  ids: number[];
  x: number;
  y: number;
  overFolder: string | null;
};

const DRAG_THRESHOLD_PX = 5;
const SPRING_EXPAND_MS = 550;
const AUTO_SCROLL_EDGE_PX = 48;
const AUTO_SCROLL_MAX_STEP = 18;

type PendingDrag = { startX: number; startY: number; rowId: number; pointerId: number };

export function useDrag(options: {
  /** ids to drag when a drag starts from this row. */
  dragIdsFor: (rowId: number) => number[];
  onDrop: (ids: number[], folder: string) => void;
  /** Called when the pointer dwells on a collapsed folder mid-drag. */
  onSpringExpand: (folder: string) => void;
}) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const pendingRef = useRef<PendingDrag | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const springRef = useRef<{ folder: string; timer: number } | null>(null);
  const scrollRaf = useRef(0);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const clearSpring = () => {
    if (springRef.current) {
      window.clearTimeout(springRef.current.timer);
      springRef.current = null;
    }
  };

  const finish = useCallback((commit: boolean) => {
    const current = dragRef.current;
    pendingRef.current = null;
    dragRef.current = null;
    clearSpring();
    window.cancelAnimationFrame(scrollRaf.current);
    document.body.removeAttribute('data-dragging');
    setDrag(null);
    if (commit && current && current.overFolder !== null) {
      optionsRef.current.onDrop(current.ids, current.overFolder);
    }
  }, []);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const pending = pendingRef.current;
      if (pending && !dragRef.current) {
        if (Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY) < DRAG_THRESHOLD_PX) return;
        const ids = optionsRef.current.dragIdsFor(pending.rowId);
        if (ids.length === 0) {
          pendingRef.current = null;
          return;
        }
        dragRef.current = { ids, x: event.clientX, y: event.clientY, overFolder: null };
        document.body.setAttribute('data-dragging', 'true');
        setDrag(dragRef.current);
      }
      const current = dragRef.current;
      if (!current) return;
      event.preventDefault();

      const element = document.elementFromPoint(event.clientX, event.clientY);
      const target = element?.closest<HTMLElement>('[data-drop-folder]') ?? null;
      const folder = target ? target.dataset.dropFolder ?? null : null;

      if (folder !== current.overFolder) {
        clearSpring();
        if (folder !== null && target?.dataset.springExpand === 'true') {
          const timer = window.setTimeout(() => optionsRef.current.onSpringExpand(folder), SPRING_EXPAND_MS);
          springRef.current = { folder, timer };
        }
      }

      // Auto-scroll any scrollable drag container the pointer is near the
      // edge of (the folder tree and the list both mark themselves).
      const scroller = element?.closest<HTMLElement>('[data-drag-scroll]');
      window.cancelAnimationFrame(scrollRaf.current);
      if (scroller) {
        const bounds = scroller.getBoundingClientRect();
        const fromTop = event.clientY - bounds.top;
        const fromBottom = bounds.bottom - event.clientY;
        let step = 0;
        if (fromTop < AUTO_SCROLL_EDGE_PX) step = -Math.ceil(((AUTO_SCROLL_EDGE_PX - fromTop) / AUTO_SCROLL_EDGE_PX) * AUTO_SCROLL_MAX_STEP);
        else if (fromBottom < AUTO_SCROLL_EDGE_PX) step = Math.ceil(((AUTO_SCROLL_EDGE_PX - fromBottom) / AUTO_SCROLL_EDGE_PX) * AUTO_SCROLL_MAX_STEP);
        if (step !== 0) {
          const tick = () => {
            scroller.scrollTop += step;
            scrollRaf.current = window.requestAnimationFrame(tick);
          };
          scrollRaf.current = window.requestAnimationFrame(tick);
        }
      }

      dragRef.current = { ...current, x: event.clientX, y: event.clientY, overFolder: folder };
      setDrag(dragRef.current);
    };

    const onUp = () => {
      if (dragRef.current) finish(true);
      else pendingRef.current = null;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dragRef.current) finish(false);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKey);
      window.cancelAnimationFrame(scrollRaf.current);
    };
  }, [finish]);

  /** Attach to a row's onPointerDown to make it draggable. */
  const beginFromRow = useCallback((event: React.PointerEvent, rowId: number) => {
    if (event.button !== 0) return;
    const element = event.target as HTMLElement;
    // Interactive children keep their own behavior.
    if (element.closest('button, a, input, select, textarea')) return;
    pendingRef.current = { startX: event.clientX, startY: event.clientY, rowId, pointerId: event.pointerId };
  }, []);

  return { drag, beginFromRow };
}
