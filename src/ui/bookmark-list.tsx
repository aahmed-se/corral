import { useCallback, useEffect, useMemo, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { CheckSquare, Square } from 'lucide-react';
import type { BookmarkRecord } from '../lib/db.ts';
import { PAGE_SIZE, type Corral, type Density } from './use-corral.ts';

const ROW_HEIGHT: Record<Density, number> = { roomy: 62, cozy: 42, compact: 28 };

const dateFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const dateYearFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

function formatDate(timestamp: number) {
  const then = new Date(timestamp);
  const now = new Date();
  if (then.getFullYear() === now.getFullYear()) return dateFormatter.format(then);
  return dateYearFormatter.format(then);
}

function SiteMark({ host }: { host: string }) {
  let hue = 0;
  for (let index = 0; index < host.length; index += 1) hue = (hue * 31 + host.charCodeAt(index)) % 360;
  return (
    <span className="site-mark" style={{ '--hue': hue } as CSSProperties} aria-hidden="true">
      {host.charAt(0).toUpperCase() || '?'}
    </span>
  );
}

export function BookmarkList({ corral, onRowPointerDown, onRowContextMenu, onImport }: {
  corral: Corral;
  onRowPointerDown: (event: ReactPointerEvent, record: BookmarkRecord) => void;
  onRowContextMenu: (event: React.MouseEvent, record: BookmarkRecord, rowIndex: number) => void;
  onImport: () => void;
}) {
  const { itemCount, isSearching, recordAt, selected, density, listVersion, loadPage } = corral;
  const listRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: itemCount,
    getScrollElement: () => listRef.current,
    estimateSize: () => ROW_HEIGHT[density],
    overscan: 16,
  });
  useEffect(() => virtualizer.measure(), [density, virtualizer]);

  // Scroll to the top when the list changes identity.
  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 });
  }, [corral.selection.view, corral.selection.folder, corral.sort, isSearching, corral.deferredQuery]);

  const virtualRows = virtualizer.getVirtualItems();
  const pageSignature = useMemo(
    () => Array.from(new Set(virtualRows.map((row) => Math.floor(row.index / PAGE_SIZE)))).join(','),
    [virtualRows],
  );
  useEffect(() => {
    if (!pageSignature) return;
    for (const page of pageSignature.split(',').map(Number)) loadPage(page, isSearching);
  }, [isSearching, listVersion, loadPage, pageSignature, corral.search.ids]);

  const openRecord = useCallback((record: BookmarkRecord) => {
    window.open(record.url, '_blank', 'noopener,noreferrer');
  }, []);

  if (itemCount === 0) {
    return (
      <div className="list-empty" ref={listRef}>
        {corral.stats.total === 0 ? (
          <>
            <h2>Nothing corralled yet</h2>
            <p>Copy your Chrome bookmarks or import an export file — everything stays on this device.</p>
            <button className="button primary large" onClick={onImport}>Import bookmarks</button>
          </>
        ) : isSearching ? (
          <>
            <h2>No matches</h2>
            <p>Corral matches anywhere in the title, URL, or folder — try fewer or shorter words.</p>
          </>
        ) : (
          <>
            <h2>Empty folder</h2>
            <p>Drag bookmarks here from another folder, or use right-click → Corral.</p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className={`bookmark-list density-${density}`} ref={listRef} role="listbox" aria-multiselectable="true" aria-label="Bookmarks" data-drag-scroll="true">
      <div className="virtual-space" style={{ height: virtualizer.getTotalSize() }}>
        {virtualRows.map((virtualRow) => {
          const record = recordAt(virtualRow.index);
          if (!record?.id) {
            return (
              <div key={`ghost-${virtualRow.index}`} className="row placeholder" aria-hidden="true" style={{ transform: `translateY(${virtualRow.start}px)`, height: virtualRow.size }}>
                <span className="ph ph-mark" /><span className="ph ph-line" />
              </div>
            );
          }
          const id = record.id;
          const isSelected = selected.has(id);
          return (
            <div
              key={id}
              className={`row${isSelected ? ' selected' : ''}`}
              style={{ transform: `translateY(${virtualRow.start}px)`, height: virtualRow.size }}
              role="option"
              aria-selected={isSelected}
              tabIndex={0}
              onPointerDown={(event) => onRowPointerDown(event, record)}
              onClick={(event) => void corral.clickRow(virtualRow.index, record, event)}
              onDoubleClick={() => openRecord(record)}
              onContextMenu={(event) => onRowContextMenu(event, record, virtualRow.index)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') openRecord(record);
                if (event.key === ' ') {
                  event.preventDefault();
                  corral.toggleSelected(record);
                }
              }}
            >
              <button
                className="row-check"
                aria-label={isSelected ? `Deselect ${record.title}` : `Select ${record.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  corral.toggleSelected(record);
                }}
              >
                {isSelected ? <CheckSquare /> : <Square />}
              </button>
              <SiteMark host={record.host} />
              <span className="row-copy">
                <span className="row-title">{record.title}</span>
                {density === 'roomy' && <span className="row-url">{record.url}</span>}
              </span>
              {density !== 'roomy' && <span className="row-host">{record.host}</span>}
              {corral.selection.view === 'all' && density !== 'compact' && (
                <button
                  className="row-folder"
                  title={record.folder}
                  onClick={(event) => {
                    event.stopPropagation();
                    corral.chooseView({ view: 'folder', folder: record.folder });
                  }}
                >
                  {record.folder}
                </button>
              )}
              <time className="row-date">{formatDate(record.dateAdded)}</time>
            </div>
          );
        })}
      </div>
    </div>
  );
}
