import { useCallback, useEffect, useMemo, useReducer, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { CheckSquare, ChevronRight, Folder, Square } from 'lucide-react';
import { db, type BookmarkRecord } from '../lib/db.ts';
import { countLabel, PAGE_SIZE, type Corral, type Density } from './use-corral.ts';

const ROW_HEIGHT: Record<Density, number> = { roomy: 62, cozy: 42, compact: 28 };

const dateFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const dateYearFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

function formatDate(timestamp: number) {
  const then = new Date(timestamp);
  const now = new Date();
  if (then.getFullYear() === now.getFullYear()) return dateFormatter.format(then);
  return dateYearFormatter.format(then);
}

// Object URLs for cached favicons, keyed by host. Module-level so scrolling
// back over rows never re-reads IndexedDB; null marks "looked up, none stored"
// so the letter mark renders without retrying every page.
const iconUrls = new Map<string, string | null>();
const iconLookups = new Set<string>();

function SiteMark({ host }: { host: string }) {
  let hue = 0;
  for (let index = 0; index < host.length; index += 1) hue = (hue * 31 + host.charCodeAt(index)) % 360;
  const iconUrl = iconUrls.get(host);
  return (
    <span className={`site-mark${iconUrl ? ' has-icon' : ''}`} style={{ '--hue': hue } as CSSProperties} aria-hidden="true">
      <span className="mark-letter">{host.charAt(0).toUpperCase() || '?'}</span>
      {iconUrl && (
        <img
          src={iconUrl}
          alt=""
          onError={(event) => {
            iconUrls.set(host, null);
            event.currentTarget.style.display = 'none';
          }}
        />
      )}
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
  const folderEntries = isSearching ? [] : corral.folderEntries;
  const folderRowCount = folderEntries.length;
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
    () => Array.from(new Set(
      virtualRows
        .filter((row) => row.index >= folderRowCount)
        .map((row) => Math.floor((row.index - folderRowCount) / PAGE_SIZE)),
    )).join(','),
    [folderRowCount, virtualRows],
  );
  useEffect(() => {
    if (!pageSignature) return;
    for (const page of pageSignature.split(',').map(Number)) loadPage(page, isSearching);
  }, [isSearching, listVersion, loadPage, pageSignature, corral.search.ids]);

  // --- favicons: resolve icons for the hosts currently on screen ---------------
  const [, bumpIcons] = useReducer((tick: number) => tick + 1, 0);

  // A finished favicon build invalidates everything already resolved.
  useEffect(() => {
    if (corral.iconVersion === 0) return;
    for (const url of iconUrls.values()) if (url) URL.revokeObjectURL(url);
    iconUrls.clear();
    iconLookups.clear();
    bumpIcons();
  }, [corral.iconVersion]);

  const visibleHosts = useMemo(() => {
    const hosts = new Set<string>();
    for (const row of virtualRows) {
      if (row.index < folderRowCount) continue;
      const record = recordAt(row.index - folderRowCount);
      if (record) hosts.add(record.host);
    }
    return Array.from(hosts);
  }, [folderRowCount, recordAt, virtualRows]);

  useEffect(() => {
    const missing = visibleHosts.filter((host) => !iconUrls.has(host) && !iconLookups.has(host));
    if (missing.length === 0) return;
    for (const host of missing) iconLookups.add(host);
    void db.favicons
      .bulkGet(missing)
      .then((rows) => {
        rows.forEach((row, index) => {
          const host = missing[index]!;
          iconLookups.delete(host);
          iconUrls.set(host, row?.bytes ? URL.createObjectURL(row.bytes) : null);
        });
        bumpIcons();
      })
      .catch(() => {
        for (const host of missing) iconLookups.delete(host);
      });
    // iconVersion: a finished build clears the cache (effect above), and the
    // hosts on screen — unchanged by that — must be looked up again.
  }, [visibleHosts, corral.iconVersion]);

  const openRecord = useCallback((record: BookmarkRecord) => {
    window.open(record.url, '_blank', 'noopener,noreferrer');
  }, []);

  if (itemCount === 0) {
    return (
      <div className="list-empty" ref={listRef}>
        {corral.stats.total === 0 && corral.selection.view === 'all' ? (
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
    <div className={`bookmark-list density-${density}`} ref={listRef} role="listbox" aria-multiselectable="true" aria-label="Folder contents" data-drag-scroll="true">
      <div className="virtual-space" style={{ height: virtualizer.getTotalSize() }}>
        {virtualRows.map((virtualRow) => {
          const folder = folderEntries[virtualRow.index];
          if (folder) {
            const openFolder = () => corral.chooseView({ view: 'folder', folder: folder.path });
            return (
              <div
                key={`folder-${folder.path}`}
                className="row folder-row"
                style={{ transform: `translateY(${virtualRow.start}px)`, height: virtualRow.size }}
                role="option"
                aria-label={`${folder.name}, ${countLabel(folder.total, 'link')}`}
                aria-selected="false"
                tabIndex={0}
                onClick={openFolder}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    openFolder();
                  }
                }}
              >
                <span className="folder-spacer" aria-hidden="true" />
                <span className="folder-mark" aria-hidden="true"><Folder /></span>
                <span className="row-copy">
                  <span className="row-title">{folder.name}</span>
                  {density === 'roomy' && <span className="row-url">{folder.path}</span>}
                </span>
                <span className="folder-count">{countLabel(folder.total, 'link')}</span>
                <ChevronRight className="folder-chevron" aria-hidden="true" />
              </div>
            );
          }

          const bookmarkIndex = virtualRow.index - folderRowCount;
          const record = recordAt(bookmarkIndex);
          if (!record?.id) {
            return (
              <div key={`ghost-${bookmarkIndex}`} className="row placeholder" aria-hidden="true" style={{ transform: `translateY(${virtualRow.start}px)`, height: virtualRow.size }}>
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
              onClick={(event) => void corral.clickRow(bookmarkIndex, record, event)}
              onDoubleClick={() => openRecord(record)}
              onContextMenu={(event) => onRowContextMenu(event, record, bookmarkIndex)}
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
              {(density !== 'compact' || (corral.selection.view === 'folder' && record.folder !== corral.selection.folder)) && (
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
