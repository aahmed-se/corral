import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  AlignJustify,
  CheckSquare,
  Copy,
  CopyMinus,
  CornerLeftUp,
  Download,
  ExternalLink,
  Folder,
  FolderInput,
  FolderPen,
  FolderPlus,
  ImageDown,
  Lasso,
  List,
  Loader2,
  Menu,
  Plus,
  Rows3,
  Search,
  Trash2,
  Undo2,
  X,
  Zap,
} from 'lucide-react';
import { db, FOLDER_SEPARATOR, UNFILED, type BookmarkRecord, type SortMode } from './lib/db.ts';
import { openableBookmarkUrl } from './lib/bookmark-url.ts';
import { BookmarkList } from './ui/bookmark-list.tsx';
import { ContextMenu, type MenuItem } from './ui/context-menu.tsx';
import { ConfirmDialog, ExportDialog, FolderPickerDialog, ImportDialog, NameDialog } from './ui/dialogs.tsx';
import { FolderTree, springExpand, type TreeNode } from './ui/folder-tree.tsx';
import { countLabel, useCorral, type Corral, type Density } from './ui/use-corral.ts';
import { useDrag, type DragPayload } from './ui/use-drag.ts';

type PickerIntent =
  | { kind: 'move'; ids: number[]; label: string }
  | { kind: 'corral'; host: string; count: number };

type MenuState = { x: number; y: number; record: BookmarkRecord; targetIds: number[] };

/** Async facts the bookmark menu shows once the worker answers: how many
 * bookmarks share the host library-wide, and which of them are in this view. */
type MenuFacts = { hostTotal: number | null; viewIds: number[] | null };

type FolderMenuState = { x: number; y: number; node: TreeNode };

type NameIntent =
  | { kind: 'create'; parent: string }
  | { kind: 'rename'; path: string; initial: string };

const DENSITIES: Array<{ id: Density; label: string; icon: React.ReactNode }> = [
  { id: 'roomy', label: 'Roomy rows', icon: <Rows3 /> },
  { id: 'cozy', label: 'Cozy rows', icon: <List /> },
  { id: 'compact', label: 'Compact rows', icon: <AlignJustify /> },
];

const SORT_LABEL: Record<SortMode, string> = { newest: 'Newest first', oldest: 'Oldest first', title: 'Title A→Z', site: 'Site A→Z' };

/** Opens up to `limit` records in new tabs — dozens at once is a popup-blocker fight. */
function openRecords(records: Array<BookmarkRecord | undefined>, limit = 15) {
  for (const record of records.slice(0, limit)) {
    const url = record ? openableBookmarkUrl(record.url) : null;
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  }
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1_048_576) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export function App() {
  const corral = useCorral();
  const selectAllRows = corral.selectAllRows;
  const clearSelection = corral.clearSelection;
  const selectedCount = corral.selected.size;
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [menuFacts, setMenuFacts] = useState<MenuFacts>({ hostTotal: null, viewIds: null });
  const [folderMenu, setFolderMenu] = useState<FolderMenuState | null>(null);
  const [picker, setPicker] = useState<PickerIntent | null>(null);
  const [nameIntent, setNameIntent] = useState<NameIntent | null>(null);
  const [dedupIds, setDedupIds] = useState<number[] | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const overlayOpen = Boolean(document.querySelector('[aria-modal="true"], [role="menu"]'));
      if (event.key === 'Escape') {
        if (overlayOpen || selectedCount === 0) return;
        event.preventDefault();
        clearSelection();
        return;
      }
      const inField = event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable], [role="dialog"], [role="menu"]');
      if (event.key === '/' && !inField && !overlayOpen && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'a') return;
      if (inField || overlayOpen) return;
      event.preventDefault();
      void selectAllRows();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [clearSelection, selectAllRows, selectedCount]);

  const { drag, beginFromRow, beginFromFolder } = useDrag({
    dragIdsFor: useCallback((rowId: number) => (corral.selected.has(rowId) ? Array.from(corral.selected) : [rowId]), [corral.selected]),
    onDrop: useCallback((payload: DragPayload, folder: string) => {
      if (payload.kind === 'rows') {
        // Dropping rows on "All bookmarks" unfiles them.
        void corral.moveIds(payload.ids, folder === '' ? UNFILED : folder);
        return;
      }
      const parent = payload.path.includes(FOLDER_SEPARATOR) ? payload.path.slice(0, payload.path.lastIndexOf(FOLDER_SEPARATOR)) : '';
      // Silently ignore drops that change nothing or would nest a folder
      // inside itself; the worker guards too, but these deserve no error toast.
      if (folder === payload.path || folder === parent || folder.startsWith(payload.path + FOLDER_SEPARATOR)) return;
      void corral.moveFolder(payload.path, folder);
    }, [corral.moveIds, corral.moveFolder]),
    onSpringExpand: springExpand,
  });

  const onRowPointerDown = useCallback((event: ReactPointerEvent, record: BookmarkRecord) => {
    if (record.id) beginFromRow(event, record.id);
  }, [beginFromRow]);

  const onFolderPointerDown = useCallback((event: ReactPointerEvent, path: string) => {
    if (path !== UNFILED) beginFromFolder(event, path);
  }, [beginFromFolder]);

  const onFolderContextMenu = useCallback((event: React.MouseEvent, node: TreeNode) => {
    setFolderMenu({ x: event.clientX, y: event.clientY, node });
  }, []);

  const runDedup = useCallback(async () => {
    const ids = await corral.findDuplicates();
    if (!ids) return;
    if (ids.length === 0) {
      corral.setToast({ message: 'No duplicate links found' });
      return;
    }
    setDedupIds(ids);
  }, [corral]);

  const onRowContextMenu = useCallback((event: React.MouseEvent, record: BookmarkRecord) => {
    event.preventDefault();
    if (!record.id) return;
    const id = record.id;
    const targetIds = corral.selected.has(id) ? Array.from(corral.selected) : [id];
    setMenu({ x: event.clientX, y: event.clientY, record, targetIds });
    setMenuFacts({ hostTotal: null, viewIds: null });
    void corral.hostCount(record.host).then((hostTotal) => setMenuFacts((facts) => ({ ...facts, hostTotal }))).catch(() => undefined);
    void corral.hostMatchesInView(id).then((viewIds) => setMenuFacts((facts) => ({ ...facts, viewIds }))).catch(() => undefined);
  }, [corral]);

  const inFolderView = corral.selection.view === 'folder';
  const scopeHint = corral.isSearching ? 'in results' : inFolderView ? 'in this folder' : 'everywhere';

  const menuItems: MenuItem[] = useMemo(() => {
    if (!menu) return [];
    const { record, targetIds } = menu;
    const many = targetIds.length > 1;
    const { hostTotal, viewIds } = menuFacts;
    const viewCount = viewIds?.length ?? null;
    const items: MenuItem[] = [
      { kind: 'item', label: many ? `Open ${countLabel(targetIds.length)}` : 'Open', icon: <ExternalLink />, onSelect: () => {
        void (targetIds.length === 1 ? Promise.resolve([record]) : db.bookmarks.bulkGet(targetIds)).then((rows) => openRecords(rows));
      } },
      { kind: 'item', label: 'Copy URL', icon: <Copy />, onSelect: () => {
        void navigator.clipboard.writeText(record.url);
        corral.setToast({ message: 'URL copied' });
      } },
      { kind: 'separator' },
      // Site actions. Selecting is the flexible one — the selection bar and
      // drag-and-drop take it from there; the library-wide roundup remains for
      // the "everything from this site in one place" case.
      { kind: 'item', label: `Show all from ${record.host}`, icon: <Search />, onSelect: () => {
        corral.setQuery(record.host);
        searchRef.current?.focus();
      } },
    ];
    if (viewCount === null || viewCount > 1) {
      items.push({
        kind: 'item',
        label: viewCount === null ? `Select all from ${record.host}` : `Select all ${viewCount.toLocaleString()} from ${record.host}`,
        hint: scopeHint,
        icon: <CheckSquare />,
        onSelect: () => {
          if (viewIds) corral.selectIds(viewIds);
          else void corral.hostMatchesInView(record.id!).then(corral.selectIds).catch(() => undefined);
        },
      });
    }
    items.push({ kind: 'separator' });
    items.push({ kind: 'item', label: many ? `Move ${countLabel(targetIds.length)} to folder…` : 'Move to folder…', icon: <FolderInput />, onSelect: () => {
      setPicker({ kind: 'move', ids: targetIds, label: many ? countLabel(targetIds.length) : record.title });
    } });
    if (hostTotal === null || hostTotal > 1) {
      items.push({
        kind: 'item',
        label: hostTotal === null ? `Corral every bookmark on ${record.host}…` : `Corral all ${hostTotal.toLocaleString()} on ${record.host}…`,
        hint: 'whole library',
        icon: <Lasso />,
        onSelect: () => setPicker({ kind: 'corral', host: record.host, count: hostTotal ?? 0 }),
      });
    }
    items.push({ kind: 'separator' });
    items.push({ kind: 'item', label: many ? `Remove ${countLabel(targetIds.length)}` : 'Remove', icon: <Trash2 />, danger: true, onSelect: () => {
      void corral.deleteIds(targetIds);
    } });
    return items;
  }, [corral, menu, menuFacts, scopeHint]);

  const folderMenuItems: MenuItem[] = useMemo(() => {
    if (!folderMenu) return [];
    const { node } = folderMenu;
    const items: MenuItem[] = [
      { kind: 'item', label: 'New subfolder…', icon: <FolderPlus />, onSelect: () => setNameIntent({ kind: 'create', parent: node.path }) },
    ];
    if (node.path !== UNFILED) {
      items.push({ kind: 'item', label: 'Rename…', icon: <FolderPen />, onSelect: () => setNameIntent({ kind: 'rename', path: node.path, initial: node.name }) });
      if (node.path.includes(FOLDER_SEPARATOR)) {
        items.push({ kind: 'item', label: 'Move to top level', icon: <CornerLeftUp />, onSelect: () => void corral.moveFolder(node.path, '') });
      }
      if (node.total === 0) {
        items.push({ kind: 'separator' }, { kind: 'item', label: 'Remove folder', icon: <Trash2 />, danger: true, onSelect: () => void corral.deleteFolder(node.path) });
      }
    }
    return items;
  }, [corral, folderMenu]);

  const heading = corral.isSearching
    ? `“${corral.deferredQuery}”`
    : corral.selection.view === 'all'
      ? 'All bookmarks'
      : corral.selection.folder;
  const searchScope = corral.isSearching && inFolderView ? ` · in ${corral.selection.folder}` : '';
  const subtitle = corral.isSearching
    ? corral.search.pending
      ? `Searching…${searchScope}`
      : `${corral.search.total.toLocaleString()} matches · ${corral.search.elapsedMs < 1 ? '<1' : corral.search.elapsedMs.toFixed(1)} ms${corral.search.truncated ? ' · top results' : ''}${searchScope}`
    : inFolderView
      ? `${countLabel(corral.viewTotal, 'link')} · ${countLabel(corral.folderEntries.length, 'folder')}`
      : countLabel(corral.viewTotal, 'link');

  const showHostColumn = corral.density !== 'roomy';

  return (
    <div className="shell" data-busy={corral.busy || undefined}>
      <header className="topbar">
        <div className="logo" aria-label="Corral">
          <Lasso aria-hidden="true" />
          <span>CORR<em>AL</em></span>
        </div>

        <label className="search">
          <Search className="search-icon" />
          <input
            ref={searchRef}
            value={corral.query}
            onChange={(event) => corral.setQuery(event.target.value)}
            placeholder={corral.stats.total > 0 ? `Search titles, URLs, folders… (${corral.stats.total.toLocaleString()} bookmarks)` : 'Search titles, URLs, folders…'}
            spellCheck={false}
            autoComplete="off"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                corral.setQuery('');
                event.currentTarget.blur();
              }
            }}
          />
          {corral.search.pending ? <Loader2 className="spin" /> : corral.query ? (
            <button className="icon-button small" aria-label="Clear search" onClick={() => corral.setQuery('')}><X /></button>
          ) : (
            <kbd>/</kbd>
          )}
        </label>

        <div className="topbar-stats" aria-label="Library">
          <div className="stat-chip"><strong>{corral.stats.total.toLocaleString()}</strong> BOOKMARKS</div>
          <div className="stat-chip"><strong>{corral.folders.length.toLocaleString()}</strong> FOLDERS</div>
          <div className="stat-chip"><strong>{formatBytes(corral.storageUsage)}</strong> ON DEVICE</div>
        </div>

        <div className="topbar-btns">
          <button
            className="tbtn"
            title="Remove duplicate links"
            disabled={corral.busy || corral.stats.total === 0}
            onClick={() => void runDedup()}
          >
            <CopyMinus /> <span className="tbtn-text">Find dups</span>
          </button>
          <button className="tbtn" title="Export" onClick={() => setExportOpen(true)}><Download /> <span className="tbtn-text">Export</span></button>
          <button className="tbtn primary" onClick={() => setImportOpen(true)}><Plus /> <span className="tbtn-text">Import</span></button>
        </div>
      </header>

      <div className="main">
        <aside className="sidebar">
          <FolderTree
            folders={corral.folders}
            total={corral.stats.total}
            selection={corral.selection}
            onSelect={corral.chooseView}
            drag={drag}
            onNewFolder={() => setNameIntent({ kind: 'create', parent: '' })}
            onFolderContextMenu={onFolderContextMenu}
            onFolderPointerDown={onFolderPointerDown}
          />
          <div className="side-status">
            <StatusLine corral={corral} />
            <FaviconLine corral={corral} />
            <div className="side-meta">
              <span>IndexedDB</span>
              <span>Local only</span>
            </div>
          </div>
        </aside>

        <section className={`content density-${corral.density}`}>
          <div className="toolbar">
            <div className="view-title">
              <h1 title={heading}>{heading}</h1>
              <span>{subtitle}</span>
            </div>
            <span className="tlabel">Sort</span>
            <select className="tsel" value={corral.sort} aria-label="Sort" onChange={(event) => corral.changeSort(event.target.value as SortMode)}>
              {(Object.keys(SORT_LABEL) as SortMode[]).map((mode) => (
                <option key={mode} value={mode}>{SORT_LABEL[mode]}</option>
              ))}
            </select>
            <div className="toolbar-sep" />
            <span className="tlabel">Rows</span>
            <div className="segmented" role="group" aria-label="Row density">
              {DENSITIES.map(({ id, label, icon }) => (
                <button
                  key={id}
                  className={corral.density === id ? 'active' : ''}
                  title={label}
                  aria-label={label}
                  aria-pressed={corral.density === id}
                  onClick={() => corral.setDensity(id)}
                >
                  {icon}
                </button>
              ))}
            </div>
          </div>

          {/* Always present, so the actions have a fixed home; they enable as soon as anything is selected. */}
          <div className={`bulk-bar${selectedCount === 0 ? ' empty' : ''}`} role="region" aria-label="Selection">
            <span className="sel-count">{selectedCount.toLocaleString()} selected</span>
            {selectedCount === 0 ? (
              <button className="tbtn ghost sm" disabled={corral.itemCount === 0} title="Select every row in this list (⌘A)" onClick={() => void corral.selectAllRows()}>
                <CheckSquare /> Select all
              </button>
            ) : corral.baseUrlSelectionPending ? (
              <button className="tbtn ghost sm" disabled>Counting…</button>
            ) : corral.canSelectAllWithBaseUrl ? (
              <button className="tbtn ghost sm" onClick={corral.selectAllWithBaseUrl}>
                + {corral.baseUrlMatchCount.toLocaleString()} with {corral.baseUrlHostCount === 1 ? 'this site' : 'these sites'}
              </button>
            ) : null}
            <span className="bulk-spacer" />
            <button className="tbtn sm" disabled={selectedCount === 0} onClick={() => setPicker({ kind: 'move', ids: Array.from(corral.selected), label: countLabel(selectedCount) })}>
              <FolderInput /> Move to…
            </button>
            <button className="tbtn danger sm" disabled={selectedCount === 0} onClick={() => void corral.deleteIds(Array.from(corral.selected))}>
              <Trash2 /> Delete
            </button>
            <button className="tbtn sm" disabled={selectedCount === 0} onClick={corral.clearSelection}><X /> Deselect</button>
          </div>

          <div className="list-header" aria-hidden="true">
            <span className="col chk" />
            <span className="col fav" />
            <span className="col title">Title / URL</span>
            {showHostColumn && <span className="col host">Site</span>}
            <span className="col folder">Folder</span>
            <span className="col date">Added</span>
            <span className="col acts" />
          </div>

          <BookmarkList corral={corral} onRowPointerDown={onRowPointerDown} onRowContextMenu={onRowContextMenu} onImport={() => setImportOpen(true)} />
        </section>
      </div>

      {drag && (
        <div className="drag-ghost" style={{ transform: `translate(${drag.x + 14}px, ${drag.y + 10}px)` }}>
          {drag.payload.kind === 'rows' ? <Menu /> : <Folder />}
          {drag.payload.kind === 'rows' ? countLabel(drag.payload.ids.length) : drag.payload.path}
          {drag.overFolder !== null && <span className="drag-target">→ {drag.overFolder === '' ? (drag.payload.kind === 'rows' ? UNFILED : 'Top level') : drag.overFolder}</span>}
        </div>
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
      {folderMenu && <ContextMenu x={folderMenu.x} y={folderMenu.y} items={folderMenuItems} onClose={() => setFolderMenu(null)} />}

      {picker && (
        <FolderPickerDialog
          title={picker.kind === 'corral' ? `Corral ${picker.host}` : `Move ${picker.label}`}
          subtitle={picker.kind === 'corral'
            ? `${picker.count > 0 ? countLabel(picker.count) : 'Every bookmark'} on ${picker.host}, from every folder in your library, will move into one folder.`
            : 'Pick an existing folder or create a new one.'}
          folders={corral.folders}
          suggested={picker.kind === 'corral' ? picker.host : undefined}
          confirmLabel={picker.kind === 'corral' ? 'Corral them' : 'Move'}
          onConfirm={(destination) => {
            if (picker.kind === 'corral') void corral.corralHost(picker.host, destination);
            else void corral.moveIds(picker.ids, destination);
          }}
          onClose={() => setPicker(null)}
        />
      )}

      {nameIntent && (
        <NameDialog
          title={nameIntent.kind === 'create' ? (nameIntent.parent ? `New folder in ${nameIntent.parent}` : 'New folder') : `Rename ${nameIntent.path}`}
          subtitle={nameIntent.kind === 'create' ? `Use “${FOLDER_SEPARATOR.trim()}” in the name to nest deeper.` : undefined}
          initial={nameIntent.kind === 'rename' ? nameIntent.initial : ''}
          placeholder="Folder name"
          confirmLabel={nameIntent.kind === 'create' ? 'Create' : 'Rename'}
          onSubmit={(name) => {
            if (nameIntent.kind === 'create') {
              void corral.createFolder(nameIntent.parent ? `${nameIntent.parent}${FOLDER_SEPARATOR}${name}` : name);
            } else {
              void corral.renameFolder(nameIntent.path, name);
            }
          }}
          onClose={() => setNameIntent(null)}
        />
      )}

      {dedupIds && (
        <ConfirmDialog
          title="Remove duplicate links"
          body={`${countLabel(dedupIds.length)} share${dedupIds.length === 1 ? 's' : ''} a URL with an older copy. Remove ${dedupIds.length === 1 ? 'it' : 'them'}? The oldest copy of each link stays, and Undo will be offered.`}
          confirmLabel={`Remove ${countLabel(dedupIds.length)}`}
          danger
          onConfirm={() => void corral.deleteIds(dedupIds)}
          onClose={() => setDedupIds(null)}
        />
      )}

      {importOpen && (
        <ImportDialog
          canUseChrome={corral.canUseChrome}
          busy={corral.busy}
          onChrome={() => void corral.importFromChrome()}
          onFile={(file) => void corral.importFromFile(file)}
          onClose={() => setImportOpen(false)}
        />
      )}
      {exportOpen && (
        <ExportDialog selectedCount={corral.selected.size} onExport={(format, only) => void corral.exportLibrary(format, only)} onClose={() => setExportOpen(false)} />
      )}

      {corral.busy && (
        <div className="busy-card" role="status">
          <Loader2 className="spin" />
          <span>{corral.busyLabel || 'Working…'}</span>
        </div>
      )}

      {corral.toast && (
        <output className="toast" aria-live="polite">
          <span>{corral.toast.message}</span>
          {corral.toast.undo && (
            <button className="toast-undo" onClick={corral.toast.undo}><Undo2 /> Undo</button>
          )}
        </output>
      )}
    </div>
  );
}

/** Site-icon cache control: idle it is a build/refresh button, running it is
 * a progress meter with a stop control. */
function FaviconLine({ corral }: { corral: Corral }) {
  const { favicons, faviconCount } = corral;
  if (favicons?.running) {
    const share = favicons.total > 0 ? Math.round((favicons.done / favicons.total) * 100) : 0;
    return (
      <div className="status-line">
        <Loader2 className="spin" />
        <span>Site icons · {favicons.total > 0 ? `${share}%` : 'checking cache…'}</span>
        <span className="status-meter"><i style={{ width: `${share}%` }} /></span>
        <button className="icon-button small" title="Stop" aria-label="Stop fetching site icons" onClick={corral.stopFavicons}><X /></button>
      </div>
    );
  }
  const idleLabel = favicons && favicons.message
    ? favicons.message
    : faviconCount > 0 || Boolean(favicons?.failed)
      ? `Update site icons · ${faviconCount.toLocaleString()} cached${favicons?.failed ? ` · ${favicons.failed.toLocaleString()} unavailable` : ''}`
      : 'Build site icon cache';
  return (
    <button
      className="status-line action"
      disabled={corral.index.status !== 'ready' || corral.stats.total === 0}
      title="Fetch favicons for every bookmarked site"
      onClick={corral.buildFavicons}
    >
      <ImageDown />
      <span>{idleLabel}</span>
    </button>
  );
}

const PHASE_LABEL = { scanning: 'Indexing', analyzing: 'Sorting', saving: 'Saving' } as const;

function StatusLine({ corral }: { corral: Corral }) {
  const { index } = corral;
  if (index.status === 'error') {
    return (
      <div className="status-line error">
        <span>{index.message || 'Indexing failed'}</span>
        <button className="tbtn ghost sm" onClick={corral.requestRebuild}>Rebuild</button>
      </div>
    );
  }
  if (index.status === 'indexing' || index.status === 'starting') {
    const label = index.status === 'starting' ? 'Opening library' : PHASE_LABEL[index.phase];
    const share = index.total > 0 ? Math.round((index.done / index.total) * 100) : 0;
    return (
      <div className="status-line">
        <Loader2 className="spin" />
        <span>{label}{index.total > 0 ? ` · ${share}%` : '…'}</span>
        <span className="status-meter"><i style={{ width: `${share}%` }} /></span>
      </div>
    );
  }
  if (index.background) {
    // Quiet compaction: the rows on screen are already current.
    const { done, total } = index.background;
    const share = total > 0 ? Math.round((done / total) * 100) : 0;
    return (
      <div className="status-line" title="Compacting the index in the background — everything stays usable.">
        <Loader2 className="spin" />
        <span>Compacting · {share}%</span>
        <span className="status-meter"><i style={{ width: `${share}%` }} /></span>
      </div>
    );
  }
  if (corral.stats.total === 0) {
    return (
      <div className="status-line ready">
        <Zap />
        <span>Ready — library empty</span>
      </div>
    );
  }
  return (
    <div className="status-line ready">
      <Zap />
      <span>{countLabel(corral.stats.total)} indexed{corral.index.restored ? '' : corral.stats.buildMs > 0 ? ` in ${(corral.stats.buildMs / 1000).toFixed(1)}s` : ''}</span>
    </div>
  );
}
