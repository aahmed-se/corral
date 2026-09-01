import { useCallback, useEffect, useMemo, useReducer, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { CheckSquare, ChevronRight, ExternalLink, Folder, FolderOpen, SearchX, Square, Trash2 } from 'lucide-react';
import { openableBookmarkUrl } from '../lib/bookmark-url.ts';
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
const ICON_URL_LIMIT = 1_024;

function releaseIconUrl(url: string | null | undefined) {
  if (url) URL.revokeObjectURL(url);
}

function cacheIconUrl(host: string, url: string | null) {
  releaseIconUrl(iconUrls.get(host));
  iconUrls.delete(host);
  iconUrls.set(host, url);
  while (iconUrls.size > ICON_URL_LIMIT) {
    const oldest = iconUrls.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    releaseIconUrl(iconUrls.get(oldest));
    iconUrls.delete(oldest);
  }
}

function clearIconUrls() {
  for (const url of iconUrls.values()) releaseIconUrl(url);
  iconUrls.clear();
  iconLookups.clear();
}

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
            cacheIconUrl(host, null);
            event.currentTarget.style.display = 'none';
            // Do not leave undecodable bytes marked fresh for a month.
            void db.favicons.delete(host);
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

  useEffect(() => clearIconUrls, []);

  // A finished favicon build invalidates everything already resolved.
  useEffect(() => {
    if (corral.iconVersion === 0) return;
    clearIconUrls();
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
    let cancelled = false;
    for (const host of missing) iconLookups.add(host);
    void db.favicons
      .bulkGet(missing)
      .then((rows) => {
        if (cancelled) return;
        rows.forEach((row, index) => {
          const host = missing[index]!;
          iconLookups.delete(host);
          cacheIconUrl(host, row?.bytes ? URL.createObjectURL(row.bytes) : null);
        });
        bumpIcons();
      })
      .catch(() => {
        for (const host of missing) iconLookups.delete(host);
      });
    return () => {
      cancelled = true;
      for (const host of missing) iconLookups.delete(host);
    };
    // iconVersion: a finished build clears the cache (effect above), and the
    // hosts on screen — unchanged by that — must be looked up again.
  }, [visibleHosts, corral.iconVersion]);

  const openRecord = useCallback((record: BookmarkRecord) => {
    const url = openableBookmarkUrl(record.url);
    if (!url) {
      corral.setToast({ message: 'That bookmark uses a blocked or invalid URL.' });
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }, [corral]);

  if (itemCount === 0) {
    return (
      <div className="list-empty" ref={listRef}>
        {corral.stats.total === 0 && corral.selection.view === 'all' ? (
          <>
            <FolderOpen className="empty-icon" aria-hidden="true" />
            <h2>Nothing corralled yet</h2>
            <p>Copy your Chrome bookmarks or import an export file — everything stays on this device.</p>
            <button className="tbtn primary" onClick={onImport}>Import bookmarks</button>
          </>
        ) : isSearching ? (
          <>
            <SearchX className="empty-icon" aria-hidden="true" />
            <h2>No matches</h2>
            <p>Corral matches anywhere in the title, URL, site, or folder — try fewer or shorter words.</p>
          </>
        ) : (
          <>
            <FolderOpen className="empty-icon" aria-hidden="true" />
            <h2>Empty folder</h2>
            <p>Drag bookmarks here from another folder, or right-click a bookmark and pick “Move to folder…”.</p>
          </>
        )}
      </div>
    );
  }

  // Rows are CSS grids sharing the column template with the list header (see
  // `--row-cols`): check · icon · title/url · site (cozy/compact) · folder ·
  // date · actions. Every branch renders one cell per column so the header
  // lines up whatever the row is.
  const showHost = density !== 'roomy';

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
                <span aria-hidden="true" />
                <span className="folder-mark" aria-hidden="true"><Folder /></span>
                <span className="row-copy">
                  <span className="row-title">{folder.name}</span>
                  {density === 'roomy' && <span className="row-url">{folder.path}</span>}
                </span>
                {showHost && <span aria-hidden="true" />}
                <span className="folder-count">{countLabel(folder.total, 'link')}</span>
                <ChevronRight className="folder-chevron" aria-hidden="true" />
                <span aria-hidden="true" />
              </div>
            );
          }

          const bookmarkIndex = virtualRow.index - folderRowCount;
          const record = recordAt(bookmarkIndex);
          if (!record?.id) {
            return (
              <div key={`ghost-${bookmarkIndex}`} className="row placeholder" aria-hidden="true" style={{ transform: `translateY(${virtualRow.start}px)`, height: virtualRow.size }}>
                <span /><span className="ph ph-mark" /><span className="ph ph-line" />
              </div>
            );
          }
          const id = record.id;
          const isSelected = selected.has(id);
          // Sits beside the text it opens (the URL in roomy rows, the title
          // otherwise) rather than in the far-right action column.
          const openButton = (
            <button
              className="row-open"
              title="Open in a new tab"
              aria-label={`Open ${record.title}`}
              onClick={(event) => {
                event.stopPropagation();
                openRecord(record);
              }}
            >
              <ExternalLink />
            </button>
          );
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
                <span className="row-line">
                  <span className="row-title">{record.title}</span>
                  {density !== 'roomy' && openButton}
                </span>
                {density === 'roomy' && (
                  <span className="row-line">
                    <span className="row-url">{record.url}</span>
                    {openButton}
                  </span>
                )}
              </span>
              {showHost && <span className="row-host" title={record.host}>{record.host}</span>}
              <button
                className="row-folder"
                title={`Open folder ${record.folder}`}
                onClick={(event) => {
                  event.stopPropagation();
                  corral.chooseView({ view: 'folder', folder: record.folder });
                }}
              >
                {record.folder}
              </button>
              <time className="row-date">{formatDate(record.dateAdded)}</time>
              <span className="row-actions">
                <button
                  className="action-btn remove"
                  title="Remove bookmark"
                  aria-label={`Remove ${record.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    void corral.deleteIds([id]);
                  }}
                >
                  <Trash2 />
                </button>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
