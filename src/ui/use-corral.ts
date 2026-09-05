import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
// Vite provides the constructor for `?worker` imports at build time.
import EngineWorker from '../lib/worker.ts?worker';
import type { IndexPhase, WorkerOp, WorkerResponse } from '../lib/worker.ts';
import {
  db,
  FOLDER_SEPARATOR,
  getFallbackPage,
  getLibraryStats,
  type BookmarkRecord,
  type FolderCount,
  type LibraryStats,
  type SortMode,
  type ViewOptions,
} from '../lib/db.ts';
import { chromeBookmarksAvailable, downloadBlob, flattenChromeTree } from '../lib/import-export.ts';
import type { BookmarkDraft } from '../lib/bookmark-edit.ts';
import { buildTree, findTreeNode } from '../lib/folder-tree.ts';

export const PAGE_SIZE = 240;
const SEARCH_LIMIT = 5_000;
const OP_SILENCE_TIMEOUT = 120_000;

export type IndexState = {
  status: 'starting' | 'indexing' | 'ready' | 'error';
  phase: IndexPhase;
  done: number;
  total: number;
  restored: boolean;
  message: string;
  /** A quiet compaction running behind a ready index — the rows on screen
   * are already current, so this is a status line, not a loading state. */
  background: { phase: IndexPhase; done: number; total: number } | null;
};

export type SearchState = {
  ids: number[];
  total: number;
  truncated: boolean;
  elapsedMs: number;
  pending: boolean;
};

export type Density = 'roomy' | 'cozy' | 'compact';

export type ViewSelection = { view: 'all' | 'folder'; folder: string };

export type ToastState = {
  message: string;
  undo?: () => void;
};

export type FaviconState = {
  running: boolean;
  done: number;
  total: number;
  ok: number;
  failed: number;
  message?: string;
};

type BaseUrlSelection = {
  ids: number[];
  hosts: string[];
  pending: boolean;
};

type UndoPlan =
  | { kind: 'relocate'; path: string; newPath: string }
  | { kind: 'edit'; record: BookmarkRecord }
  | { kind: 'folders'; moves: Array<{ id: number; folder: string }> }
  | { kind: 'records'; records: BookmarkRecord[] };

type PageResult = { rows: Array<BookmarkRecord | undefined>; total?: number };

type PendingPage = { resolve: (result: PageResult) => void; reject: (error: Error) => void; timer: number };

type PendingOp = {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  onProgress?: (label: string) => void;
  watchdog: number;
};

const emptyStats: LibraryStats = {
  key: 'stats',
  indexVersion: 0,
  revision: 0,
  dirtyRevision: 0,
  total: 0,
  hosts: 0,
  folders: 0,
  shards: 0,
  indexedAt: 0,
  buildMs: 0,
};

const emptySearch: SearchState = { ids: [], total: 0, truncated: false, elapsedMs: 0, pending: false };

const countCachedFavicons = () => db.favicons.where('status').equals('ok').count().catch(() => 0);

export function countLabel(count: number, noun = 'bookmark') {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
}

function createPendingOp(
  resolve: (payload: unknown) => void,
  reject: (error: Error) => void,
  onProgress: ((label: string) => void) | undefined,
  expire: () => void,
): PendingOp {
  const pending: PendingOp = {
    resolve,
    reject,
    onProgress: (label) => {
      window.clearTimeout(pending.watchdog);
      pending.watchdog = window.setTimeout(expire, OP_SILENCE_TIMEOUT);
      onProgress?.(label);
    },
    watchdog: window.setTimeout(expire, OP_SILENCE_TIMEOUT),
  };
  return pending;
}

export function useCorral() {
  const [stats, setStats] = useState<LibraryStats>(emptyStats);
  const [folders, setFolders] = useState<FolderCount[]>([]);
  const [index, setIndex] = useState<IndexState>({ status: 'starting', phase: 'scanning', done: 0, total: 0, restored: false, message: '', background: null });
  const [storageUsage, setStorageUsage] = useState(0);

  const [selection, setSelection] = useState<ViewSelection>({ view: 'all', folder: '' });
  const [sort, setSort] = useState<SortMode>('newest');
  const [density, setDensity] = useState<Density>(() => {
    const stored = typeof window === 'undefined' ? null : window.localStorage.getItem('corral-density');
    return stored === 'roomy' || stored === 'cozy' || stored === 'compact' ? stored : 'cozy';
  });

  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query.trim());
  const [search, setSearch] = useState<SearchState>(emptySearch);

  const [viewTotal, setViewTotal] = useState(0);
  const [pageCache, setPageCache] = useState<Map<string, Array<BookmarkRecord | undefined>>>(new Map());
  const [listVersion, setListVersion] = useState(0);

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [baseUrlSelection, setBaseUrlSelection] = useState<BaseUrlSelection>({ ids: [], hosts: [], pending: false });
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('');
  const [deletionRequest, setDeletionRequest] = useState<number[] | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [favicons, setFavicons] = useState<FaviconState | null>(null);
  const [faviconCount, setFaviconCount] = useState(0);
  /** Bumped when a favicon pass finishes, so rows re-check the icon cache. */
  const [iconVersion, setIconVersion] = useState(0);

  const workerRef = useRef<Worker | null>(null);
  const searchRequestRef = useRef(0);
  const pageRequestRef = useRef(0);
  const opRequestRef = useRef(0);
  const pendingPagesRef = useRef(new Map<number, PendingPage>());
  const pendingOpsRef = useRef(new Map<number, PendingOp>());
  const loadingPagesRef = useRef(new Map<string, number>());
  const pageGenerationRef = useRef(0);
  const searchIdsRef = useRef<number[]>([]);
  const lastTrimmedQueryRef = useRef('');
  const viewIdsCacheRef = useRef<{ version: number; ids: number[] } | null>(null);
  const selectionAnchorRef = useRef<number | null>(null);

  const canUseChrome = chromeBookmarksAvailable();
  const isSearching = deferredQuery.length > 0;

  const viewOptions = useCallback(
    (offset = 0, limit = 0): ViewOptions => ({ view: selection.view, folder: selection.folder, subtree: false, sort, offset, limit }),
    [selection.folder, selection.view, sort],
  );

  // --- worker RPC -------------------------------------------------------------
  const runOp = useCallback(<T,>(op: WorkerOp, onProgress?: (label: string) => void) => {
    const worker = workerRef.current;
    if (!worker) return Promise.reject(new Error('The engine is still starting.'));
    const requestId = ++opRequestRef.current;
    return new Promise<T>((resolve, reject) => {
      const pending = createPendingOp(resolve as (payload: unknown) => void, reject, onProgress, () => {
        pendingOpsRef.current.delete(requestId);
        reject(new Error('The operation stopped responding. Reload and try again.'));
      });
      pendingOpsRef.current.set(requestId, pending);
      try {
        worker.postMessage({ type: 'op', requestId, op });
      } catch (error) {
        window.clearTimeout(pending.watchdog);
        pendingOpsRef.current.delete(requestId);
        reject(error instanceof Error ? error : new Error('The engine rejected the request.'));
      }
    });
  }, []);

  const requestPage = useCallback((options: ViewOptions) => {
    const worker = workerRef.current;
    if (!worker) return Promise.reject(new Error('The engine is still starting.'));
    const requestId = ++pageRequestRef.current;
    return new Promise<PageResult>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pendingPagesRef.current.delete(requestId);
        reject(new Error('The page request timed out.'));
      }, 6_000);
      pendingPagesRef.current.set(requestId, { resolve, reject, timer });
      worker.postMessage({ type: 'page', requestId, options });
    });
  }, []);

  /** Folder tree, icon count, and storage figure — everything the sidebar
   * shows that is not a row. Cheap: the folder list is an instant worker read. */
  const refreshSidebar = useCallback(async () => {
    const sidebar = await runOp<{ folders: FolderCount[]; stale: boolean }>({ kind: 'folders' }).catch(() => ({ folders: [], stale: true }));
    if (!sidebar.stale) setFolders(sidebar.folders);
    setFaviconCount(await countCachedFavicons());
    if (navigator.storage?.estimate) {
      const estimate = await navigator.storage.estimate();
      setStorageUsage(estimate.usage ?? 0);
    }
  }, [runOp]);

  const refreshMetadata = useCallback(async (nextStats?: LibraryStats) => {
    // The stats row's `total` is the indexed count, tombstoned deletes
    // included; the table is the live figure the UI should show.
    const [base, total] = await Promise.all([nextStats ?? getLibraryStats(), db.bookmarks.count()]);
    setStats({ ...base, total });
    await refreshSidebar();
  }, [refreshSidebar]);

  const invalidateList = useCallback(() => {
    pageGenerationRef.current += 1;
    loadingPagesRef.current.clear();
    viewIdsCacheRef.current = null;
    setPageCache(new Map());
    setListVersion((version) => version + 1);
  }, []);

  // --- worker lifecycle ---------------------------------------------------------
  useEffect(() => {
    const worker = new EngineWorker();
    const pendingPages = pendingPagesRef.current;
    const pendingOps = pendingOpsRef.current;
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.type === 'phase') {
        const progress = { phase: message.phase, done: message.done, total: message.total };
        if (message.quiet) setIndex((current) => ({ ...current, background: progress }));
        else setIndex((current) => ({ ...current, status: 'indexing', ...progress, background: null }));
      }
      if (message.type === 'ready') {
        setIndex({ status: 'ready', phase: 'scanning', done: message.stats.total, total: message.stats.total, restored: message.restored, message: '', background: null });
        void refreshMetadata(message.stats);
        // A quiet compaction changed no row anyone can see; the pages on screen
        // stay put. Anything else (first index, import, another tab's edit)
        // may have reordered or added rows, so the list re-pages.
        if (!message.quiet) invalidateList();
      }
      if (message.type === 'results') {
        if (message.requestId !== searchRequestRef.current) return;
        selectionAnchorRef.current = null;
        pageGenerationRef.current += 1;
        for (const key of loadingPagesRef.current.keys()) if (key.startsWith('s')) loadingPagesRef.current.delete(key);
        searchIdsRef.current = message.ids;
        setSearch({ ids: message.ids, total: message.total, truncated: message.truncated, elapsedMs: message.elapsedMs, pending: false });
        setPageCache((current) => {
          const next = new Map(current);
          for (const key of next.keys()) if (key.startsWith('s')) next.delete(key);
          return next;
        });
      }
      if (message.type === 'page' || message.type === 'page-error') {
        const pending = pendingPagesRef.current.get(message.requestId);
        if (!pending) return;
        window.clearTimeout(pending.timer);
        pendingPagesRef.current.delete(message.requestId);
        if (message.type === 'page') pending.resolve({ rows: message.rows, total: message.total });
        else pending.reject(new Error(message.message));
      }
      if (message.type === 'op-progress') {
        pendingOpsRef.current.get(message.requestId)?.onProgress?.(message.label);
      }
      if (message.type === 'op-done' || message.type === 'op-error') {
        const pending = pendingOpsRef.current.get(message.requestId);
        if (!pending) return;
        window.clearTimeout(pending.watchdog);
        pendingOpsRef.current.delete(message.requestId);
        if (message.type === 'op-done') pending.resolve(message.payload);
        else pending.reject(new Error(message.message));
      }
      if (message.type === 'favicon-progress') {
        setFavicons({ running: message.running, done: message.done, total: message.total, ok: message.ok, failed: message.failed, message: message.message });
        if (!message.running) {
          setIconVersion((version) => version + 1);
          void countCachedFavicons().then(setFaviconCount);
        }
      }
      if (message.type === 'fatal') {
        setIndex((current) => ({ ...current, status: 'error', message: message.message }));
      }
    };
    worker.onerror = () => {
      setIndex((current) => ({ ...current, status: 'error', message: 'The engine worker stopped unexpectedly.' }));
      for (const pending of pendingOps.values()) {
        window.clearTimeout(pending.watchdog);
        pending.reject(new Error('The engine worker stopped unexpectedly.'));
      }
      pendingOps.clear();
    };

    void (async () => {
      try {
        await refreshMetadata();
        worker.postMessage({ type: 'init' });
      } catch (error) {
        setIndex((current) => ({ ...current, status: 'error', message: error instanceof Error ? error.message : 'The library could not be opened.' }));
      }
    })();

    return () => {
      for (const pending of pendingPages.values()) window.clearTimeout(pending.timer);
      pendingPages.clear();
      for (const pending of pendingOps.values()) window.clearTimeout(pending.watchdog);
      pendingOps.clear();
      worker.terminate();
      workerRef.current = null;
    };
  }, [invalidateList, refreshMetadata]);

  useEffect(() => {
    window.localStorage.setItem('corral-density', density);
  }, [density]);

  // --- view totals -----------------------------------------------------------------
  // Re-counted whenever the list is invalidated or the view changes. This
  // effect never invalidates the list itself: the stats row used to drive
  // invalidation, which re-paged every row (and flashed placeholders) each time
  // the worker reported in after a mutation.
  useEffect(() => {
    let cancelled = false;
    void runOp<{ total: number }>({ kind: 'view-total', options: viewOptions() })
      .catch(() => ({ total: 0 }))
      .then(({ total }) => {
        if (!cancelled) setViewTotal(total);
      });
    return () => {
      cancelled = true;
    };
  }, [listVersion, runOp, viewOptions]);

  // --- search -------------------------------------------------------------------
  const updateQuery = useCallback((value: string) => {
    const trimmed = value.trim();
    setQuery(value);
    if (trimmed !== lastTrimmedQueryRef.current) {
      searchRequestRef.current += 1;
      invalidateList();
      setSelected(new Set());
      selectionAnchorRef.current = null;
    }
    if (trimmed && trimmed !== lastTrimmedQueryRef.current) {
      setSearch((current) => ({ ...current, pending: true }));
    } else if (!trimmed && lastTrimmedQueryRef.current) {
      searchRequestRef.current += 1;
      searchIdsRef.current = [];
      setSearch(emptySearch);
    }
    lastTrimmedQueryRef.current = trimmed;
  }, [invalidateList]);

  useEffect(() => {
    if (!deferredQuery) return;
    const requestId = ++searchRequestRef.current;
    // Search is scoped to the selected folder; picking a folder mid-search
    // narrows the same query rather than clearing it.
    const folder = selection.view === 'folder' ? selection.folder : undefined;
    const timer = window.setTimeout(() => {
      workerRef.current?.postMessage({ type: 'search', requestId, query: deferredQuery, limit: SEARCH_LIMIT, folder });
    }, 30);
    return () => window.clearTimeout(timer);
  }, [deferredQuery, index.status, selection.folder, selection.view, listVersion]);

  // --- toast --------------------------------------------------------------------
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), toast.undo ? 8_000 : 3_500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // --- paging -------------------------------------------------------------------
  const loadPage = useCallback((page: number, searching: boolean) => {
    const key = `${searching ? 's' : 'v'}${page}`;
    if (loadingPagesRef.current.has(key)) return;
    const generation = pageGenerationRef.current;
    loadingPagesRef.current.set(key, generation);
    const request: Promise<PageResult> = searching
      ? db.bookmarks.bulkGet(searchIdsRef.current.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)).then((rows) => ({ rows }))
      : requestPage(viewOptions(page * PAGE_SIZE, PAGE_SIZE)).catch(async () => ({ rows: await getFallbackPage(viewOptions(page * PAGE_SIZE, PAGE_SIZE)) }));
    void request
      .then(({ rows, total }) => {
        if (generation !== pageGenerationRef.current) {
          if (loadingPagesRef.current.get(key) === generation) loadingPagesRef.current.delete(key);
          return;
        }
        setPageCache((current) => {
          const next = new Map(current);
          next.set(key, rows);
          return next;
        });
        if (!searching && typeof total === 'number') setViewTotal((current) => (current === total ? current : total));
      })
      .catch(() => {
        if (loadingPagesRef.current.get(key) === generation) loadingPagesRef.current.delete(key);
      });
  }, [requestPage, viewOptions]);

  const recordAt = useCallback(
    (rowIndex: number) => {
      const key = `${isSearching ? 's' : 'v'}${Math.floor(rowIndex / PAGE_SIZE)}`;
      return pageCache.get(key)?.[rowIndex % PAGE_SIZE];
    },
    [isSearching, pageCache],
  );

  // --- navigation -----------------------------------------------------------------
  // Page cache keys carry no view identity, so a view or sort change must
  // drop the cache (batched into the same render as the selection change).
  const chooseView = useCallback((view: ViewSelection) => {
    invalidateList();
    searchRequestRef.current += 1;
    setSelection(view);
    setSelected(new Set());
    selectionAnchorRef.current = null;
    // An active query stays and re-runs against the new scope.
    if (lastTrimmedQueryRef.current) setSearch((current) => ({ ...current, pending: true }));
  }, [invalidateList]);

  const changeSort = useCallback((mode: SortMode) => {
    invalidateList();
    selectionAnchorRef.current = null;
    setSort(mode);
  }, [invalidateList]);

  // A range anchor is an index into one specific ordered result list. It must
  // never survive a query/scope identity change and point into another list.
  useEffect(() => {
    selectionAnchorRef.current = null;
  }, [deferredQuery, selection.folder, selection.view, sort]);

  // --- selection -------------------------------------------------------------------
  /** Ordered ids of the current list (view or search), cached per invalidation. */
  const currentIds = useCallback(async () => {
    if (isSearching) {
      if (search.pending || query.trim() !== deferredQuery) throw new Error('Wait for the current search to finish.');
      return searchIdsRef.current;
    }
    const cached = viewIdsCacheRef.current;
    const version = pageGenerationRef.current;
    if (cached && cached.version === version) return cached.ids;
    const { ids } = await runOp<{ ids: number[] }>({ kind: 'view-ids', options: viewOptions() });
    if (version === pageGenerationRef.current) viewIdsCacheRef.current = { version, ids };
    return ids;
  }, [isSearching, runOp, viewOptions, search.pending, query, deferredQuery]);

  const selectAllRows = useCallback(async () => {
    try {
      const generation = pageGenerationRef.current;
      const ids = await currentIds();
      if (generation !== pageGenerationRef.current) return;
      setSelected(new Set(ids));
      selectionAnchorRef.current = null;
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : 'Could not select the current rows' });
    }
  }, [currentIds]);

  const clickRow = useCallback(async (rowIndex: number, record: BookmarkRecord, event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    const id = record.id!;
    const toggle = event.metaKey || event.ctrlKey;
    if (event.shiftKey && selectionAnchorRef.current !== null) {
      const anchor = selectionAnchorRef.current;
      const generation = pageGenerationRef.current;
      let ids: number[];
      try { ids = await currentIds(); } catch { return; }
      if (generation !== pageGenerationRef.current) return;
      const [from, to] = anchor <= rowIndex ? [anchor, rowIndex] : [rowIndex, anchor];
      const range = ids.slice(from, to + 1);
      setSelected((current) => {
        const next = toggle ? new Set(current) : new Set<number>();
        for (const member of range) next.add(member);
        return next;
      });
      return;
    }
    selectionAnchorRef.current = rowIndex;
    setSelected((current) => {
      if (toggle) {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }
      return new Set([id]);
    });
  }, [currentIds]);

  const toggleSelected = useCallback((record: BookmarkRecord) => {
    const id = record.id;
    if (!id) return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  useEffect(() => {
    const memberIds = Array.from(selected);
    if (memberIds.length === 0) {
      setBaseUrlSelection({ ids: [], hosts: [], pending: false });
      return;
    }
    if (!isSearching && memberIds.length === viewTotal) {
      setBaseUrlSelection({ ids: [], hosts: [], pending: false });
      return;
    }

    let cancelled = false;
    setBaseUrlSelection({ ids: [], hosts: [], pending: true });
    void runOp<{ hosts: string[]; ids: number[] }>({
      kind: 'expand-host-selection',
      ids: memberIds,
      options: viewOptions(),
      scopeIds: isSearching ? searchIdsRef.current : undefined,
    })
      .then(({ hosts, ids }) => {
        if (!cancelled) setBaseUrlSelection({ ids, hosts, pending: false });
      })
      .catch(() => {
        if (!cancelled) setBaseUrlSelection({ ids: [], hosts: [], pending: false });
      });
    return () => {
      cancelled = true;
    };
  }, [isSearching, runOp, search.ids, selected, viewOptions, viewTotal]);

  const selectAllWithBaseUrl = useCallback(() => {
    if (baseUrlSelection.pending || baseUrlSelection.ids.length === 0) return;
    setSelected((current) => {
      const next = new Set(current);
      for (const id of baseUrlSelection.ids) next.add(id);
      return next;
    });
    selectionAnchorRef.current = null;
  }, [baseUrlSelection]);

  const clearSelection = useCallback(() => {
    setSelected(new Set());
    selectionAnchorRef.current = null;
  }, []);

  // --- mutations --------------------------------------------------------------------
  // Mutations patch the worker's index before they report done, so re-paging
  // the list and re-reading the folder tree here shows the final state — there
  // is no later "ready" to wait for.
  const refreshAfterMutation = useCallback(async () => {
    setSelected(new Set());
    selectionAnchorRef.current = null;
    invalidateList();
    const total = await db.bookmarks.count();
    setStats((current) => ({ ...current, total }));
    await refreshSidebar();
  }, [invalidateList, refreshSidebar]);

  const offerUndo = useCallback((message: string, plan: UndoPlan | null) => {
    if (!plan || (plan.kind === 'folders' && plan.moves.length === 0) || (plan.kind === 'records' && plan.records.length === 0)) {
      setToast({ message });
      return;
    }
    setToast({
      message,
      undo: () => {
        setToast(null);
        setBusy(true);
        const op: WorkerOp = plan.kind === 'folders' ? { kind: 'restore-folders', moves: plan.moves }
          : plan.kind === 'relocate' ? { kind: 'undo-relocate', path: plan.path, newPath: plan.newPath }
          : plan.kind === 'edit' ? { kind: 'save-bookmark', id: plan.record.id, draft: plan.record }
          : { kind: 'restore-records', records: plan.records };
        runOp<{ restored: number }>(op, setBusyLabel)
          .then(async ({ restored }) => {
            await refreshAfterMutation();
            if (plan.kind === 'relocate') setSelection((current) => current.view === 'folder' && (current.folder === plan.path || current.folder.startsWith(plan.path + FOLDER_SEPARATOR))
              ? { ...current, folder: plan.newPath + current.folder.slice(plan.path.length) } : current);
            setToast({ message: plan.kind === 'relocate' ? 'Folder restored' : plan.kind === 'edit' ? 'Bookmark restored' : `${countLabel(restored)} restored` });
          })
          .catch((error) => setToast({ message: error instanceof Error ? error.message : 'Undo failed' }))
          .finally(() => setBusy(false));
      },
    });
  }, [refreshAfterMutation, runOp]);

  const moveIds = useCallback(async (ids: number[], destination: string) => {
    if (ids.length === 0 || !destination.trim()) return;
    setBusy(true);
    setBusyLabel(`Moving ${countLabel(ids.length)}…`);
    try {
      const { moved, destination: applied, priorFolders } = await runOp<{ moved: number; destination: string; priorFolders: Array<{ id: number; folder: string }> }>(
        { kind: 'move', ids, destination },
        setBusyLabel,
      );
      await refreshAfterMutation();
      offerUndo(`${countLabel(moved)} moved to ${applied}`, { kind: 'folders', moves: priorFolders });
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : 'Could not move those bookmarks' });
    } finally {
      setBusy(false);
    }
  }, [offerUndo, refreshAfterMutation, runOp]);

  /** Moves every bookmark on `host` into `destination` — library-wide, or
   * only inside `folder`'s subtree when given. */
  const corralHost = useCallback(async (host: string, destination: string, folder?: string) => {
    if (!host || !destination.trim()) return;
    setBusy(true);
    setBusyLabel(`Corralling ${host}…`);
    try {
      const { moved, destination: applied, priorFolders } = await runOp<{ moved: number; destination: string; priorFolders: Array<{ id: number; folder: string }> }>(
        { kind: 'corral-host', host, destination, folder },
        setBusyLabel,
      );
      await refreshAfterMutation();
      offerUndo(`${countLabel(moved)} from ${host} corralled into ${applied}`, { kind: 'folders', moves: priorFolders });
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : 'Could not corral that site' });
    } finally {
      setBusy(false);
    }
  }, [offerUndo, refreshAfterMutation, runOp]);

  const deleteIds = useCallback(async (ids: number[], confirmed = false) => {
    if (ids.length === 0) return;
    if (ids.length > 50_000 && !confirmed) { setDeletionRequest(ids); return; }
    setDeletionRequest(null);
    setBusy(true);
    setBusyLabel(`Removing ${countLabel(ids.length)}…`);
    try {
      const { deleted, undoRecords } = await runOp<{ deleted: number; undoRecords: BookmarkRecord[] | null }>({ kind: 'delete', ids }, setBusyLabel);
      await refreshAfterMutation();
      offerUndo(`${countLabel(deleted)} removed`, undoRecords ? { kind: 'records', records: undoRecords } : null);
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : 'Could not remove those bookmarks' });
    } finally {
      setBusy(false);
    }
  }, [offerUndo, refreshAfterMutation, runOp]);

  const saveBookmark = useCallback(async (draft: BookmarkDraft, id?: number) => {
    setBusy(true);
    setBusyLabel(id === undefined ? 'Adding bookmark…' : 'Saving bookmark…');
    try {
      const { previous } = await runOp<{ previous?: BookmarkRecord }>({ kind: 'save-bookmark', draft, id }, setBusyLabel);
      await refreshAfterMutation();
      offerUndo(id === undefined ? 'Bookmark added' : 'Bookmark updated', previous ? { kind: 'edit', record: previous } : null);
      return true;
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : 'Could not save bookmark' });
      return false;
    } finally { setBusy(false); }
  }, [offerUndo, refreshAfterMutation, runOp]);

  const importFromChrome = useCallback(async () => {
    if (!canUseChrome) return;
    setBusy(true);
    setBusyLabel('Reading the Chrome bookmark tree…');
    try {
      const tree = await chrome.bookmarks.getTree();
      const inputs = flattenChromeTree(tree);
      const { imported, skipped } = await runOp<{ imported: number; skipped: number }>({ kind: 'import-chrome', inputs }, setBusyLabel);
      await refreshAfterMutation();
      setToast({ message: imported > 0
        ? `${countLabel(imported)} new from Chrome · ${countLabel(skipped)} already kept`
        : `No new Chrome bookmarks · ${countLabel(skipped)} already kept` });
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : 'Chrome copy failed' });
      await refreshAfterMutation().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }, [canUseChrome, refreshAfterMutation, runOp]);

  const importFromFile = useCallback(async (file: File) => {
    setBusy(true);
    setBusyLabel(`Reading ${file.name}…`);
    try {
      const text = await file.text();
      const { imported, skipped } = await runOp<{ imported: number; skipped: number }>({ kind: 'import-file', name: file.name, text }, setBusyLabel);
      await refreshAfterMutation();
      setToast({ message: imported > 0
        ? `${countLabel(imported)} new · ${countLabel(skipped)} already kept`
        : `Nothing new to import · ${countLabel(skipped)} already kept` });
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : 'Could not import that file' });
    } finally {
      setBusy(false);
    }
  }, [refreshAfterMutation, runOp]);

  const exportLibrary = useCallback(async (format: 'json' | 'html', onlySelection: boolean) => {
    setBusy(true);
    setBusyLabel('Preparing export…');
    try {
      const ids = onlySelection && selected.size > 0 ? Array.from(selected) : undefined;
      const { blob, exported, filename } = await runOp<{ blob: Blob; exported: number; filename: string }>({ kind: 'export', format, ids }, setBusyLabel);
      downloadBlob(filename, blob);
      setToast({ message: `${countLabel(exported)} exported` });
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : 'Could not export' });
    } finally {
      setBusy(false);
    }
  }, [runOp, selected]);

  const hostCount = useCallback(async (host: string) => {
    const { count } = await runOp<{ count: number }>({ kind: 'host-count', host });
    return count;
  }, [runOp]);

  /** Ids of every bookmark in the current list (folder scope or search
   * results) that shares this record's base host. */
  const hostMatchesInView = useCallback(async (id: number) => {
    const { ids } = await runOp<{ hosts: string[]; ids: number[] }>({
      kind: 'expand-host-selection',
      ids: [id],
      options: viewOptions(),
      scopeIds: isSearching ? searchIdsRef.current : undefined,
    });
    return ids;
  }, [isSearching, runOp, viewOptions]);

  const selectIds = useCallback((ids: number[]) => {
    setSelected(new Set(ids));
    selectionAnchorRef.current = null;
  }, []);

  // --- folder management -----------------------------------------------------------
  /** Keeps a selection inside a relocated subtree pointing at the new path. */
  const retargetSelection = useCallback((path: string, newPath: string) => {
    setSelection((current) => {
      if (current.view !== 'folder') return current;
      if (current.folder === path || current.folder.startsWith(path + FOLDER_SEPARATOR)) {
        return { view: 'folder', folder: newPath + current.folder.slice(path.length) };
      }
      return current;
    });
  }, []);

  const createFolder = useCallback(async (path: string) => {
    try {
      const { created } = await runOp<{ created: string }>({ kind: 'create-folder', path });
      await refreshSidebar();
      setToast({ message: `Folder “${created}” created` });
      return created;
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : 'Could not create that folder' });
      return null;
    }
  }, [refreshSidebar, runOp]);

  type RelocatePayload = { moved: number; path: string; newPath: string };

  const renameFolder = useCallback(async (path: string, newName: string) => {
    setBusy(true);
    setBusyLabel(`Renaming ${path}…`);
    try {
      const { newPath } = await runOp<RelocatePayload>({ kind: 'rename-folder', path, newName }, setBusyLabel);
      retargetSelection(path, newPath);
      await refreshAfterMutation();
      await refreshSidebar();
      offerUndo(`Renamed to ${newPath}`, newPath !== path ? { kind: 'relocate', path: newPath, newPath: path } : null);
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : 'Could not rename that folder' });
    } finally {
      setBusy(false);
    }
  }, [offerUndo, refreshAfterMutation, refreshSidebar, retargetSelection, runOp]);

  const moveFolder = useCallback(async (path: string, newParent: string) => {
    setBusy(true);
    setBusyLabel(`Moving ${path}…`);
    try {
      const { newPath } = await runOp<RelocatePayload>({ kind: 'move-folder', path, newParent }, setBusyLabel);
      retargetSelection(path, newPath);
      await refreshAfterMutation();
      await refreshSidebar();
      offerUndo(`${path} is now ${newPath}`, newPath !== path ? { kind: 'relocate', path: newPath, newPath: path } : null);
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : 'Could not move that folder' });
    } finally {
      setBusy(false);
    }
  }, [offerUndo, refreshAfterMutation, refreshSidebar, retargetSelection, runOp]);

  const deleteFolder = useCallback(async (path: string) => {
    try {
      const { removed } = await runOp<{ removed: string }>({ kind: 'delete-folder', path });
      setSelection((current) =>
        current.view === 'folder' && (current.folder === removed || current.folder.startsWith(removed + FOLDER_SEPARATOR))
          ? { view: 'all', folder: '' }
          : current,
      );
      await refreshSidebar();
      setToast({ message: `Folder “${removed}” removed` });
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : 'Could not remove that folder' });
    }
  }, [refreshSidebar, runOp]);

  // --- duplicates -------------------------------------------------------------------
  /** Scans the library and returns the ids of every duplicate copy (the oldest
   * copy of each URL stays); null when the scan failed. */
  const findDuplicates = useCallback(async () => {
    setBusy(true);
    setBusyLabel('Scanning for duplicate links…');
    try {
      const { duplicateIds } = await runOp<{ duplicateIds: number[] }>({ kind: 'find-duplicates' }, setBusyLabel);
      return duplicateIds;
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : 'The duplicate scan failed' });
      return null;
    } finally {
      setBusy(false);
    }
  }, [runOp]);

  // --- favicons ----------------------------------------------------------------------
  const buildFavicons = useCallback(() => {
    const extension = typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
    // Extension pages read Chrome's own favicon cache; the dev preview goes
    // through the vite proxy to Google's favicon service.
    const source = extension
      ? { mode: 'chrome' as const, prefix: chrome.runtime.getURL('_favicon/'), retryFailures: true }
      : { mode: 's2' as const, prefix: '/s2-favicon?sz=32&domain=', retryFailures: true };
    setFavicons({ running: true, done: 0, total: 0, ok: 0, failed: 0 });
    workerRef.current?.postMessage({ type: 'favicons', source });
  }, []);

  const stopFavicons = useCallback(() => {
    workerRef.current?.postMessage({ type: 'favicons-stop' });
  }, []);

  const folderEntries = useMemo(() => {
    if (isSearching || selection.view !== 'folder') return [];
    return findTreeNode(buildTree(folders), selection.folder)?.children ?? [];
  }, [folders, isSearching, selection.folder, selection.view]);
  const itemCount = isSearching ? search.ids.length : viewTotal + folderEntries.length;
  const baseUrlSelectionComplete = baseUrlSelection.ids.every((id) => selected.has(id));
  const baseUrlMatchCount = new Set([...selected, ...baseUrlSelection.ids]).size;

  return {
    stats, folders, index, storageUsage,
    selection, chooseView, sort, changeSort, density, setDensity,
    query, setQuery: updateQuery, deferredQuery, isSearching, search,
    itemCount, viewTotal, folderEntries, listVersion, loadPage, recordAt,
    selected, setSelected, clickRow, toggleSelected, selectAllRows,
    selectAllWithBaseUrl, baseUrlMatchCount,
    baseUrlHostCount: baseUrlSelection.hosts.length, baseUrlSelectionPending: baseUrlSelection.pending,
    canSelectAllWithBaseUrl: baseUrlSelection.ids.length > 0 && !baseUrlSelectionComplete,
    clearSelection,
    saveBookmark, deletionRequest, setDeletionRequest, moveIds, corralHost, deleteIds, importFromChrome, importFromFile, exportLibrary, hostCount, hostMatchesInView, selectIds,
    createFolder, renameFolder, moveFolder, deleteFolder, findDuplicates,
    favicons, faviconCount, iconVersion, buildFavicons, stopFavicons,
    canUseChrome, busy, busyLabel, toast, setToast,
    requestRebuild: useCallback(() => workerRef.current?.postMessage({ type: 'rebuild' }), []),
  };
}

export type Corral = ReturnType<typeof useCorral>;
