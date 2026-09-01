import Dexie, { type EntityTable, type Table } from 'dexie';
import { yieldToQueue } from './task-queue.ts';
import type { PersistedViewData } from './view-index.ts';

export type BookmarkSource = 'chrome' | 'html' | 'json';
export type SortMode = 'newest' | 'oldest' | 'title' | 'site';
export type ViewKind = 'all' | 'folder';

export type ViewOptions = {
  view: ViewKind;
  /** Exact folder path, e.g. "Reading / Research". */
  folder: string;
  /** When true, a folder view includes every descendant folder. */
  subtree: boolean;
  sort: SortMode;
  offset: number;
  limit: number;
};

export type BookmarkRecord = {
  id?: number;
  chromeId?: string;
  title: string;
  url: string;
  normalizedUrl: string;
  host: string;
  folder: string;
  dateAdded: number;
  importedAt: number;
  source: BookmarkSource;
};

export type FolderCount = { folder: string; count: number };

export type LibraryStats = {
  key: 'stats';
  /** Invalidates persisted shards when their searchable-field layout changes. */
  indexVersion: number;
  revision: number;
  /** The library's dirty token at the time this index was built. */
  dirtyRevision: number;
  total: number;
  hosts: number;
  folders: number;
  /** Persisted shard rows, delta shards included. */
  shards: number;
  /** Shards written by the last full build; the rest are delta shards. Absent
   * on rows written before delta shards existed (treated as `shards`). */
  baseShards?: number;
  indexedAt: number;
  buildMs: number;
};

export type TombstoneRow = {
  key: 'tombstones';
  revision: number;
  ids: Uint32Array;
};

export type DirtyRow = {
  key: 'dirty';
  revision: number;
};

/** Folders the user created that hold no records yet — they exist only here
 * until a bookmark lands in them. */
export type ExtraFoldersRow = {
  key: 'extraFolders';
  names: string[];
};

export type MetaRow = LibraryStats | TombstoneRow | DirtyRow | ExtraFoldersRow;

/** Per-host favicon/metadata cache. `bytes` is null when the fetch failed or
 * the host has no icon; `fetchedAt` makes the builder resumable. */
export type FaviconRow = {
  host: string;
  bytes: Blob | null;
  status: 'ok' | 'missing' | 'error';
  fetchedAt: number;
};

export type ShardRow = {
  seq: number;
  revision: number;
  ids: Uint32Array;
  starts: Uint32Array;
  text: string;
};

/** One row per index revision holding the worker's in-memory view ordering
 * (see view-index.ts), so a restart restores O(page) paging without a rescan.
 * Shape-validated on restore; anything unrecognized triggers a rebuild. */
export type ViewDataRow = { revision: number } & PersistedViewData;

class CorralDatabase extends Dexie {
  bookmarks!: EntityTable<BookmarkRecord, 'id'>;
  meta!: Table<MetaRow, string>;
  searchShards!: Table<ShardRow, number>;
  viewData!: Table<ViewDataRow, number>;
  favicons!: Table<FaviconRow, string>;

  constructor() {
    super('corral');
    // Ordering, search, and aggregates live in the worker's in-memory index.
    // `folder` alone serves export streaming and pre-index paging.
    this.version(1).stores({
      bookmarks: '++id, source, folder',
      meta: '&key',
      searchShards: '&seq, revision',
      viewData: '&revision',
    });
    // v2: per-host favicon cache.
    this.version(2).stores({
      favicons: '&host, fetchedAt',
    });
    // v3: status makes successful-cache counts cheap and accurate.
    this.version(3).stores({
      favicons: '&host, status, fetchedAt',
    });
    // v4: source is record metadata, not a query path. Dropping its index
    // removes write amplification from every large import without touching
    // any bookmark rows.
    this.version(4).stores({
      bookmarks: '++id, folder',
    });
  }
}

export const db = new CorralDatabase();

const trackingParams = new Set(['fbclid', 'gclid', 'dclid', 'mc_cid', 'mc_eid', 'ref_src', 'igshid']);

export const PAGE_BATCH = 5_000;
export const FOLDER_SEPARATOR = ' / ';

export function normalizeUrl(rawUrl: string) {
  const raw = rawUrl.trim();
  try {
    const url = new URL(raw);
    url.hostname = url.hostname.toLowerCase();
    url.hash = '';
    if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) url.port = '';
    url.pathname = url.pathname.replace(/\/{2,}/g, '/');
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    const entries = Array.from(url.searchParams.entries())
      .filter(([key]) => !key.toLowerCase().startsWith('utm_') && !trackingParams.has(key.toLowerCase()))
      .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
        leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey),
      );
    url.search = '';
    for (const [key, value] of entries) url.searchParams.append(key, value);
    return url.toString();
  } catch {
    return raw.toLowerCase();
  }
}

export function getBaseHost(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.hostname.toLowerCase().replace(/^www\./, '');
    return url.protocol.replace(':', '') || 'other';
  } catch {
    return 'invalid-url';
  }
}

// Control characters in titles or folder names are junk at best; in folder
// names they would also corrupt the persisted NUL-joined name lists.
// oxlint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f]+/g;

export function sanitizeName(value: string) {
  return value.replace(CONTROL_CHARACTERS, ' ').trim();
}

export const UNFILED = 'Unsorted';

export function makeRecord(
  input: Pick<BookmarkRecord, 'title' | 'url' | 'folder' | 'dateAdded' | 'source'> & { chromeId?: string },
): BookmarkRecord {
  return {
    ...input,
    title: sanitizeName(input.title) || input.url,
    folder: sanitizeName(input.folder) || UNFILED,
    normalizedUrl: normalizeUrl(input.url),
    host: getBaseHost(input.url),
    importedAt: Date.now(),
  };
}

/** Stamps the library as changed, so an index built earlier (or a rebuild
 * interrupted by closing the tab) can never pass the restore-validity check —
 * even when the record count happens to match. */
export async function markLibraryDirty() {
  await db.transaction('rw', db.meta, async () => {
    const row = await db.meta.get('dirty');
    const previous = row && row.key === 'dirty' ? row.revision : 0;
    await db.meta.put({ key: 'dirty', revision: Math.max(Date.now(), previous + 1) });
  });
}

export async function getDirtyRevision() {
  const row = await db.meta.get('dirty');
  return row && row.key === 'dirty' ? row.revision : 0;
}

export async function getLibraryStats(): Promise<LibraryStats> {
  const stored = await db.meta.get('stats');
  if (stored && stored.key === 'stats') return stored;
  return {
    key: 'stats',
    indexVersion: 0,
    revision: 0,
    dirtyRevision: 0,
    total: await db.bookmarks.count(),
    hosts: 0,
    folders: 0,
    shards: 0,
    indexedAt: 0,
    buildMs: 0,
  };
}

/** Pre-index fallback paging: primary-key order, relaxed sort. Only shallow
 * offsets are reachable before the first index finishes. */
export async function getFallbackPage(options: ViewOptions) {
  const { view, folder, subtree, sort, offset, limit } = options;
  if (view === 'folder') {
    if (subtree) {
      const prefix = folder + FOLDER_SEPARATOR;
      return db.bookmarks
        .filter((record) => record.folder === folder || record.folder.startsWith(prefix))
        .offset(offset)
        .limit(limit)
        .toArray();
    }
    return db.bookmarks.where('folder').equals(folder).offset(offset).limit(limit).toArray();
  }
  const collection = db.bookmarks.toCollection();
  return (sort === 'oldest' ? collection : collection.reverse()).offset(offset).limit(limit).toArray();
}

export async function getRecordsByIds(ids: number[], onProgress?: (read: number) => void) {
  const result: BookmarkRecord[] = [];
  for (let offset = 0; offset < ids.length; offset += PAGE_BATCH) {
    const rows = await db.bookmarks.bulkGet(ids.slice(offset, offset + PAGE_BATCH));
    result.push(...rows.filter((record): record is BookmarkRecord => Boolean(record)));
    onProgress?.(result.length);
  }
  return result;
}

export async function addRecordsInBatches(records: BookmarkRecord[], onProgress?: (written: number) => void) {
  let written = 0;
  for (let offset = 0; offset < records.length; offset += PAGE_BATCH) {
    const batch = records.slice(offset, offset + PAGE_BATCH);
    await db.bookmarks.bulkAdd(batch);
    written += batch.length;
    onProgress?.(written);
    await yieldToQueue();
  }
  return written;
}

export async function moveToFolder(ids: number[], folder: string, onProgress?: (moved: number) => void) {
  const destination = sanitizeName(folder);
  if (!destination) throw new Error('Choose a destination folder.');
  let moved = 0;
  for (let offset = 0; offset < ids.length; offset += 1_000) {
    const rows = await db.bookmarks.bulkGet(ids.slice(offset, offset + 1_000));
    const updated = rows.flatMap((record) => (record ? [{ ...record, folder: destination }] : []));
    await db.bookmarks.bulkPut(updated);
    moved += updated.length;
    onProgress?.(moved);
    await yieldToQueue();
  }
  return moved;
}

export async function getExtraFolders(): Promise<string[]> {
  const row = await db.meta.get('extraFolders');
  return row && row.key === 'extraFolders' ? row.names : [];
}

export async function setExtraFolders(names: string[]) {
  await db.meta.put({ key: 'extraFolders', names: Array.from(new Set(names)).sort() });
}

export async function deleteByIds(ids: number[], onProgress?: (deleted: number) => void) {
  let deleted = 0;
  for (let offset = 0; offset < ids.length; offset += 1_000) {
    const batch = ids.slice(offset, offset + 1_000);
    await db.bookmarks.bulkDelete(batch);
    deleted += batch.length;
    onProgress?.(deleted);
    await yieldToQueue();
  }
  return deleted;
}
