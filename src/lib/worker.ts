/// <reference lib="webworker" />

// Corral's engine worker. All data work happens here — the UI thread only
// renders and talks to the chrome.* APIs. One streamed pass over the
// bookmarks table builds the search shards, the view ordering, and the
// folder/host counts together, with progress for every phase; the previous
// index keeps serving while a rebuild runs.

import {
  db,
  deleteByIds,
  FOLDER_SEPARATOR,
  getDirtyRevision,
  getExtraFolders,
  getFallbackPage,
  getRecordsByIds,
  makeRecord,
  markLibraryDirty,
  moveToFolder,
  sanitizeName,
  setExtraFolders,
  UNFILED,
  type BookmarkRecord,
  type FaviconRow,
  type FolderCount,
  type LibraryStats,
  type ShardRow,
  type ViewOptions,
} from './db.ts';
import { parseBookmarkJson, parseNetscapeHtml, toNetscapeHtmlParts, type RawBookmarkInput } from './import-export.ts';
import {
  chromeFaviconPageUrlCandidates,
  chromeFaviconUrl,
  faviconNeedsFetch,
  previewFaviconUrl,
  type FaviconSource,
} from './favicon-cache.ts';
import { ShardBuilder, ShardStore, type ShardData } from './search-engine.ts';
import { deserializeViewData, serializeViewData, ViewIndex, ViewIndexBuilder } from './view-index.ts';
import { yieldToQueue } from './task-queue.ts';

export type WorkerOp =
  | { kind: 'import-file'; name: string; text: string }
  | { kind: 'import-chrome'; inputs: RawBookmarkInput[] }
  /** Moves ids into a folder; returns prior folders so the UI can offer undo. */
  | { kind: 'move'; ids: number[]; destination: string }
  /** Moves every bookmark on `host` into a folder. */
  | { kind: 'corral-host'; host: string; destination: string }
  | { kind: 'delete'; ids: number[] }
  /** Undo for a move/corral: puts each record back into its prior folder. */
  | { kind: 'restore-folders'; moves: Array<{ id: number; folder: string }> }
  /** Undo for a delete: re-inserts the records with their original ids. */
  | { kind: 'restore-records'; records: BookmarkRecord[] }
  | { kind: 'export'; format: 'json' | 'html'; ids?: number[] }
  /** Registers an empty folder (it exists only in meta until records land). */
  | { kind: 'create-folder'; path: string }
  /** Renames a folder in place; every descendant path follows. */
  | { kind: 'rename-folder'; path: string; newName: string }
  /** Re-parents a folder (newParent '' = top level); descendants follow. */
  | { kind: 'move-folder'; path: string; newParent: string }
  /** Removes a folder that holds no records anywhere in its subtree. */
  | { kind: 'delete-folder'; path: string }
  /** Scans for records sharing a normalized URL; returns the ids of every
   * copy except the oldest, ready for the delete flow. */
  | { kind: 'find-duplicates' }
  // Read-only:
  | { kind: 'folders' }
  | { kind: 'host-count'; host: string }
  /** Expands a selection to every bookmark with the same base hosts inside
   * the active all/folder scope. */
  | { kind: 'expand-host-selection'; ids: number[]; options: ViewOptions }
  | { kind: 'view-ids'; options: ViewOptions }
  | { kind: 'view-total'; options: ViewOptions };

export type IndexPhase = 'scanning' | 'analyzing' | 'saving';

export type WorkerRequest =
  | { type: 'init' }
  | { type: 'rebuild' }
  /** `folder` scopes matching to that folder's subtree. */
  | { type: 'search'; requestId: number; query: string; limit: number; folder?: string }
  | { type: 'page'; requestId: number; options: ViewOptions }
  | { type: 'op'; requestId: number; op: WorkerOp }
  | { type: 'favicons'; source: FaviconSource }
  | { type: 'favicons-stop' };

export type WorkerResponse =
  | { type: 'phase'; phase: IndexPhase; done: number; total: number }
  | { type: 'ready'; stats: LibraryStats; restored: boolean }
  | { type: 'results'; requestId: number; ids: number[]; total: number; truncated: boolean; elapsedMs: number }
  | { type: 'page'; requestId: number; rows: Array<BookmarkRecord | undefined>; total?: number }
  | { type: 'page-error'; requestId: number; message: string }
  | { type: 'op-progress'; requestId: number; label: string }
  | { type: 'op-done'; requestId: number; payload?: unknown }
  | { type: 'op-error'; requestId: number; message: string }
  | { type: 'favicon-progress'; done: number; total: number; ok: number; failed: number; running: boolean; message?: string }
  | { type: 'fatal'; message: string };

const scope = self as unknown as {
  postMessage: (message: WorkerResponse) => void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

const SCAN_CHUNK = 4_000;
const SHARD_WRITE_CHUNK = 8;
const INSERT_CHUNK = 5_000;
/** Deletions larger than this skip the in-memory undo payload. */
export const UNDO_RECORD_LIMIT = 50_000;

let serving: ShardStore | null = null;
let servingViews: ViewIndex | null = null;
let servingRevision = 0;
let rebuilding = false;
let rebuildAgain = false;
let pendingTombstones: number[] = [];

function post(message: WorkerResponse) {
  scope.postMessage(message);
}

const count = (value: number, noun = 'bookmark') => `${value.toLocaleString()} ${noun}${value === 1 ? '' : 's'}`;

async function persistTombstones() {
  const store = serving;
  await db.meta.put({ key: 'tombstones', revision: servingRevision, ids: store ? store.tombstoneIds : new Uint32Array(0) });
}

async function boot() {
  const stats = await db.meta.get('stats');
  if (stats && stats.key === 'stats' && stats.indexedAt > 0) {
    const tombstoneRow = await db.meta.get('tombstones');
    const tombstones = tombstoneRow && tombstoneRow.key === 'tombstones' && tombstoneRow.revision === stats.revision
      ? Array.from(tombstoneRow.ids)
      : [];
    const total = await db.bookmarks.count();
    const dirtyRevision = await getDirtyRevision();
    if (total === stats.total - tombstones.length && dirtyRevision === stats.dirtyRevision) {
      const rows = await db.searchShards.where('revision').equals(stats.revision).sortBy('seq');
      const viewData = deserializeViewData(await db.viewData.get(stats.revision));
      if (rows.length === stats.shards && viewData) {
        const shards: ShardData[] = rows.map((row) => ({ ids: row.ids, starts: row.starts, text: row.text }));
        serving = ShardStore.fromShards(shards, tombstones);
        servingViews = new ViewIndex(viewData, tombstones);
        servingRevision = stats.revision;
        post({ type: 'ready', stats, restored: true });
        // Tombstones mean the on-disk index predates some deletions;
        // reconcile in the background while the restored index serves.
        if (tombstones.length > 0) void rebuild();
        return;
      }
    }
  }
  await rebuild();
}

async function rebuild() {
  if (rebuilding) {
    rebuildAgain = true;
    return;
  }
  rebuilding = true;
  rebuildAgain = false;
  pendingTombstones = [];
  const started = performance.now();
  const revision = Date.now();

  try {
    // Captured before the scan: a mutation landing mid-rebuild bumps the live
    // token past this, so an interrupted rebuild self-identifies as stale on
    // the next launch (rebuildAgain covers the current session).
    const dirtyRevision = await getDirtyRevision();
    const total = await db.bookmarks.count();
    post({ type: 'phase', phase: 'scanning', done: 0, total });

    const shardBuilder = new ShardBuilder();
    const viewBuilder = new ViewIndexBuilder();
    const folderIds = new Map<string, number>();
    const hostIds = new Map<string, number>();
    const folderNames: string[] = [];
    const hostNames: string[] = [];
    let scanned = 0;
    let lastId = 0;

    for (;;) {
      const records = await db.bookmarks.where('id').above(lastId).limit(SCAN_CHUNK).toArray();
      if (records.length === 0) break;
      for (const record of records) {
        if (!record.id) continue;
        shardBuilder.add({ id: record.id, title: record.title, url: record.url, host: record.host, folder: record.folder });
        // Sanitized exactly like makeRecord sanitizes new records, so a name
        // can never corrupt the persisted NUL-joined name lists.
        const folderName = sanitizeName(record.folder) || UNFILED;
        let folderId = folderIds.get(folderName);
        if (folderId === undefined) {
          folderId = folderNames.length;
          folderIds.set(folderName, folderId);
          folderNames.push(folderName);
        }
        let hostId = hostIds.get(record.host);
        if (hostId === undefined) {
          hostId = hostNames.length;
          hostIds.set(record.host, hostId);
          hostNames.push(record.host);
        }
        viewBuilder.add(record.id, record.dateAdded, record.title, folderId, hostId);
      }
      scanned += records.length;
      lastId = records.at(-1)?.id ?? lastId;
      post({ type: 'phase', phase: 'scanning', done: scanned, total });
      await yieldToQueue();
    }
    const shards = shardBuilder.finish();

    // The three permutation sorts — the only O(n log n) step.
    post({ type: 'phase', phase: 'analyzing', done: scanned, total: scanned });
    await yieldToQueue();
    const viewData = viewBuilder.finish(folderNames, hostNames);
    await yieldToQueue();

    // Persist shards and the view ordering; stats last, as the commit marker.
    // Nothing written here scales with unique-host count.
    const saveTotal = shards.length + 1;
    let saved = 0;
    const reportSave = () => post({ type: 'phase', phase: 'saving', done: saved, total: saveTotal });
    reportSave();

    await db.searchShards.clear();
    for (let offset = 0; offset < shards.length; offset += SHARD_WRITE_CHUNK) {
      const rows: ShardRow[] = shards
        .slice(offset, offset + SHARD_WRITE_CHUNK)
        .map((shard, index) => ({ seq: offset + index, revision, ids: shard.ids, starts: shard.starts, text: shard.text }));
      await db.searchShards.bulkAdd(rows);
      saved += rows.length;
      reportSave();
      await yieldToQueue();
    }
    await db.viewData.clear();
    await db.viewData.add({ revision, ...serializeViewData(viewData) });
    saved += 1;
    reportSave();

    const stats: LibraryStats = {
      key: 'stats',
      revision,
      dirtyRevision,
      total: scanned,
      hosts: hostNames.length,
      folders: folderNames.length,
      shards: shards.length,
      indexedAt: Date.now(),
      buildMs: Math.round(performance.now() - started),
    };
    serving = ShardStore.fromShards(shards, pendingTombstones);
    servingViews = new ViewIndex(viewData, pendingTombstones);
    servingRevision = revision;
    pendingTombstones = [];
    await persistTombstones();
    await db.meta.put(stats);
    // User-created folders that gained records now live in the scan; keeping
    // them in the extras list would double them in the sidebar. Transactional,
    // so a create-folder op landing mid-prune is not lost.
    await db.transaction('rw', db.meta, async () => {
      const row = await db.meta.get('extraFolders');
      const names = row && row.key === 'extraFolders' ? row.names : [];
      const pruned = names.filter((name) => !folderIds.has(name));
      if (pruned.length !== names.length) await db.meta.put({ key: 'extraFolders', names: pruned });
    });
    post({ type: 'ready', stats, restored: false });
  } catch (error) {
    post({ type: 'fatal', message: error instanceof Error ? error.message : 'Indexing failed' });
  } finally {
    rebuilding = false;
    if (rebuildAgain) void rebuild();
  }
}

function applyTombstones(ids: number[]) {
  serving?.tombstone(ids);
  servingViews?.tombstone(ids);
  if (rebuilding) pendingTombstones.push(...ids);
  else if (serving) void persistTombstones();
}

function runSearch(requestId: number, query: string, limit: number, folder?: string) {
  const started = performance.now();
  // Folder scope: hand the engine a membership predicate. If the view index
  // is momentarily rebuilding, an unscoped answer would silently widen the
  // scope — an empty pending result is less wrong.
  let accept: ((id: number) => boolean) | undefined;
  if (folder !== undefined) {
    if (!servingViews) {
      post({ type: 'results', requestId, ids: [], total: 0, truncated: false, elapsedMs: 0 });
      return;
    }
    const members = servingViews.folderMemberSet(folder);
    accept = (id) => members.has(id);
  }
  const result = serving ? serving.search(query, limit, accept) : { ids: [], total: 0, truncated: false };
  post({ type: 'results', requestId, ids: result.ids, total: result.total, truncated: result.truncated, elapsedMs: performance.now() - started });
}

async function readPage(requestId: number, options: ViewOptions) {
  try {
    if (servingViews) {
      const { ids, total } = servingViews.page(options, options.offset, options.limit);
      const rows = await db.bookmarks.bulkGet(ids);
      post({ type: 'page', requestId, rows, total });
      return;
    }
    // Before the first index exists, fall back to primary-key paging — only
    // shallow offsets are reachable then.
    const rows = await getFallbackPage(options);
    post({ type: 'page', requestId, rows });
  } catch (error) {
    post({ type: 'page-error', requestId, message: error instanceof Error ? error.message : 'The page could not be read.' });
  }
}

type Progress = (label: string) => void;

type OpOutcome = {
  payload?: unknown;
  rebuild?: boolean;
  staleViews?: boolean;
  tombstoneIds?: number[];
};

async function insertInputs(inputs: RawBookmarkInput[], progress: Progress) {
  let written = 0;
  for (let offset = 0; offset < inputs.length; offset += INSERT_CHUNK) {
    const records = inputs.slice(offset, offset + INSERT_CHUNK).map((input) => makeRecord(input));
    await db.bookmarks.bulkAdd(records);
    written += records.length;
    progress(`Imported ${count(written)} of ${count(inputs.length)}…`);
    await yieldToQueue();
  }
  return written;
}

/** Moves ids and returns each record's prior folder for the undo toast. */
async function moveWithUndo(ids: number[], destination: string, progress: Progress) {
  const records = await getRecordsByIds(ids, (read) => progress(`Reading ${count(read)} of ${count(ids.length)}…`));
  const priorFolders = records.map((record) => ({ id: record.id!, folder: record.folder }));
  await markLibraryDirty();
  const moved = await moveToFolder(ids, destination, (done) => progress(`Moved ${count(done)} of ${count(ids.length)}…`));
  return { moved, priorFolders };
}

/** Distinct folder paths that are `path` or live under it, per the folder
 * index — the record-backed half of the tree (extras are checked separately). */
async function subtreeFolderNames(path: string) {
  const names = (await db.bookmarks.orderBy('folder').uniqueKeys()) as string[];
  const prefix = path + FOLDER_SEPARATOR;
  return names.filter((name) => name === path || name.startsWith(prefix));
}

/** Rewrites the `path` prefix to `newPath` on every record in the subtree and
 * on the extras list, returning prior folders for the undo toast. */
async function relocateFolder(path: string, newPath: string, progress: Progress) {
  await markLibraryDirty();
  const affected = await subtreeFolderNames(path);
  const priorFolders: Array<{ id: number; folder: string }> = [];
  let moved = 0;
  for (const name of affected) {
    const target = newPath + name.slice(path.length);
    const keys = (await db.bookmarks.where('folder').equals(name).primaryKeys()) as number[];
    for (let offset = 0; offset < keys.length; offset += 1_000) {
      const rows = await db.bookmarks.bulkGet(keys.slice(offset, offset + 1_000));
      const updated: BookmarkRecord[] = [];
      for (const record of rows) {
        if (!record) continue;
        priorFolders.push({ id: record.id!, folder: record.folder });
        updated.push({ ...record, folder: target });
      }
      await db.bookmarks.bulkPut(updated);
      moved += updated.length;
      progress(`Moved ${count(moved)}…`);
      await yieldToQueue();
    }
  }
  const prefix = path + FOLDER_SEPARATOR;
  const extras = await getExtraFolders();
  const renamed = extras.map((name) => (name === path || name.startsWith(prefix) ? newPath + name.slice(path.length) : name));
  // A record-less folder exists only through extras; keep it alive under its
  // new path even when the old path was implied by children rather than listed.
  if (moved === 0 && !renamed.includes(newPath)) renamed.push(newPath);
  await setExtraFolders(renamed);
  return { moved, priorFolders };
}

/** Full path → sanitized full path; empty when nothing survives. */
function sanitizePath(path: string) {
  return path.split(FOLDER_SEPARATOR).map((part) => sanitizeName(part)).filter(Boolean).join(FOLDER_SEPARATOR);
}

function parentOf(path: string) {
  const cut = path.lastIndexOf(FOLDER_SEPARATOR);
  return cut === -1 ? '' : path.slice(0, cut);
}

function leafOf(path: string) {
  const cut = path.lastIndexOf(FOLDER_SEPARATOR);
  return cut === -1 ? path : path.slice(cut + FOLDER_SEPARATOR.length);
}

async function runOp(op: WorkerOp, progress: Progress): Promise<OpOutcome> {
  switch (op.kind) {
    case 'import-file': {
      progress(`Parsing ${op.name}…`);
      const inputs = op.name.toLowerCase().endsWith('.json') ? parseBookmarkJson(op.text) : parseNetscapeHtml(op.text);
      if (inputs.length === 0) throw new Error('No bookmarks were found in that file.');
      await markLibraryDirty();
      const imported = await insertInputs(inputs, progress);
      return { payload: { imported }, rebuild: true, staleViews: true };
    }

    case 'import-chrome': {
      const existing = await db.bookmarks.where('source').equals('chrome').toArray();
      await markLibraryDirty();
      let tombstoneIds: number[] = [];
      if (existing.length > 0) {
        progress('Replacing the previous Chrome copy…');
        await db.bookmarks.where('source').equals('chrome').delete();
        tombstoneIds = existing.map((record) => record.id).filter((id): id is number => typeof id === 'number');
      }
      const imported = await insertInputs(op.inputs, progress);
      return { payload: { imported, replaced: existing.length }, rebuild: true, staleViews: true, tombstoneIds };
    }

    case 'move': {
      const destination = sanitizeName(op.destination);
      if (!destination) throw new Error('Choose a destination folder.');
      const { moved, priorFolders } = await moveWithUndo(op.ids, destination, progress);
      return { payload: { moved, destination, priorFolders }, rebuild: true, staleViews: true };
    }

    case 'corral-host': {
      const destination = sanitizeName(op.destination);
      if (!destination) throw new Error('Choose a destination folder.');
      if (!servingViews) throw new Error('Still indexing — try again in a moment.');
      const ids = servingViews.idsForHost(op.host);
      if (ids.length === 0) throw new Error(`No bookmarks found on ${op.host}.`);
      const { moved, priorFolders } = await moveWithUndo(ids, destination, progress);
      return { payload: { moved, destination, priorFolders }, rebuild: true, staleViews: true };
    }

    case 'delete': {
      await markLibraryDirty();
      // Keep the records in the response so the UI can offer undo — but only
      // up to a bound; re-adding 200k records from a toast is not a feature.
      const undoRecords = op.ids.length <= UNDO_RECORD_LIMIT
        ? await getRecordsByIds(op.ids, (read) => progress(`Reading ${count(read)} of ${count(op.ids.length)}…`))
        : null;
      const deleted = await deleteByIds(op.ids, (done) => progress(`Removed ${count(done)} of ${count(op.ids.length)}…`));
      return { payload: { deleted, undoRecords }, rebuild: true, tombstoneIds: op.ids };
    }

    case 'restore-folders': {
      await markLibraryDirty();
      let restored = 0;
      for (let offset = 0; offset < op.moves.length; offset += 1_000) {
        const batch = op.moves.slice(offset, offset + 1_000);
        const rows = await db.bookmarks.bulkGet(batch.map((move) => move.id));
        const updated: BookmarkRecord[] = [];
        for (let index = 0; index < batch.length; index += 1) {
          const record = rows[index];
          if (record) updated.push({ ...record, folder: batch[index]!.folder });
        }
        await db.bookmarks.bulkPut(updated);
        restored += updated.length;
        progress(`Moved ${count(restored)} of ${count(op.moves.length)} back…`);
        await yieldToQueue();
      }
      return { payload: { restored }, rebuild: true, staleViews: true };
    }

    case 'restore-records': {
      await markLibraryDirty();
      let restored = 0;
      for (let offset = 0; offset < op.records.length; offset += 1_000) {
        const batch = op.records.slice(offset, offset + 1_000);
        // Original ids are preserved; IndexedDB's key generator never reuses
        // an id after a delete, so this cannot collide.
        await db.bookmarks.bulkPut(batch);
        restored += batch.length;
        progress(`Restored ${count(restored)} of ${count(op.records.length)}…`);
        await yieldToQueue();
      }
      return { payload: { restored }, rebuild: true, staleViews: true };
    }

    case 'export':
      return exportRecords(op.format, op.ids, progress);

    case 'create-folder': {
      const path = sanitizePath(op.path);
      if (!path) throw new Error('Name the folder first.');
      const known = new Set((servingViews ? servingViews.folders() : []).map((entry) => entry.folder));
      const extras = await getExtraFolders();
      if (known.has(path) || extras.includes(path)) throw new Error(`“${path}” already exists.`);
      await setExtraFolders([...extras, path]);
      return { payload: { created: path } };
    }

    case 'rename-folder': {
      if (op.path === UNFILED) throw new Error(`${UNFILED} is where unfiled bookmarks land — it can't be renamed.`);
      const leaf = sanitizePath(op.newName);
      if (!leaf) throw new Error('Name the folder first.');
      const parent = parentOf(op.path);
      const newPath = parent ? `${parent}${FOLDER_SEPARATOR}${leaf}` : leaf;
      if (newPath === op.path) return { payload: { moved: 0, path: op.path, newPath, priorFolders: [] } };
      const { moved, priorFolders } = await relocateFolder(op.path, newPath, progress);
      return { payload: { moved, path: op.path, newPath, priorFolders }, rebuild: true, staleViews: true };
    }

    case 'move-folder': {
      if (op.path === UNFILED) throw new Error(`${UNFILED} is where unfiled bookmarks land — it can't be moved.`);
      const newParent = sanitizePath(op.newParent);
      if (newParent === op.path || newParent.startsWith(op.path + FOLDER_SEPARATOR)) {
        throw new Error('A folder can’t move into its own subtree.');
      }
      const newPath = newParent ? `${newParent}${FOLDER_SEPARATOR}${leafOf(op.path)}` : leafOf(op.path);
      if (newPath === op.path) return { payload: { moved: 0, path: op.path, newPath, priorFolders: [] } };
      const { moved, priorFolders } = await relocateFolder(op.path, newPath, progress);
      return { payload: { moved, path: op.path, newPath, priorFolders }, rebuild: true, staleViews: true };
    }

    case 'delete-folder': {
      if (op.path === UNFILED) throw new Error(`${UNFILED} can't be removed.`);
      const occupied = await subtreeFolderNames(op.path);
      if (occupied.length > 0) throw new Error('Only empty folders can be removed — move or delete its bookmarks first.');
      const prefix = op.path + FOLDER_SEPARATOR;
      const extras = await getExtraFolders();
      await setExtraFolders(extras.filter((name) => name !== op.path && !name.startsWith(prefix)));
      return { payload: { removed: op.path } };
    }

    case 'find-duplicates': {
      const total = await db.bookmarks.count();
      // Keyed by the normalized URL computed at import time (tracking params
      // stripped, host lowercased, fragment dropped). Keeps the oldest copy.
      const keepers = new Map<string, { id: number; date: number }>();
      const extras: number[] = [];
      let scanned = 0;
      let lastId = 0;
      for (;;) {
        const records = await db.bookmarks.where('id').above(lastId).limit(SCAN_CHUNK).toArray();
        if (records.length === 0) break;
        lastId = records.at(-1)?.id ?? lastId;
        for (const record of records) {
          if (!record.id) continue;
          const key = record.normalizedUrl || record.url;
          const best = keepers.get(key);
          if (!best) {
            keepers.set(key, { id: record.id, date: record.dateAdded });
          } else if (record.dateAdded < best.date || (record.dateAdded === best.date && record.id < best.id)) {
            extras.push(best.id);
            keepers.set(key, { id: record.id, date: record.dateAdded });
          } else {
            extras.push(record.id);
          }
        }
        scanned += records.length;
        progress(`Checked ${count(scanned)} of ${count(total)}…`);
        await yieldToQueue();
      }
      return { payload: { duplicateIds: extras } };
    }

    case 'folders': {
      const folders: FolderCount[] = servingViews ? servingViews.folders() : [];
      // User-created folders with no records yet only exist in meta.
      const known = new Set(folders.map((entry) => entry.folder));
      for (const name of await getExtraFolders()) {
        if (!known.has(name)) folders.push({ folder: name, count: 0 });
      }
      return { payload: { folders, stale: !servingViews } };
    }

    case 'host-count':
      return { payload: { count: servingViews ? servingViews.hostCount(op.host) : 0 } };

    case 'expand-host-selection': {
      if (servingViews) return { payload: servingViews.hostExpansion(op.ids, op.options) };

      // Before the in-memory index is ready, derive the same result from the
      // live rows so the selection action remains available during a rebuild.
      const members = await getRecordsByIds(op.ids);
      const hostSet = new Set(members.map((record) => record.host));
      const hosts = Array.from(hostSet).sort();
      if (hosts.length === 0) return { payload: { hosts, ids: [] } };
      const rows = await getFallbackPage({ ...op.options, offset: 0, limit: Number.MAX_SAFE_INTEGER });
      const ids = rows
        .filter((record) => hostSet.has(record.host))
        .map((record) => record.id)
        .filter((id): id is number => typeof id === 'number');
      return { payload: { hosts, ids } };
    }

    case 'view-ids': {
      if (servingViews) return { payload: { ids: servingViews.page(op.options, 0, Number.MAX_SAFE_INTEGER).ids } };
      const rows = await getFallbackPage({ ...op.options, offset: 0, limit: Number.MAX_SAFE_INTEGER });
      return { payload: { ids: rows.map((row) => row.id).filter((id): id is number => typeof id === 'number') } };
    }

    case 'view-total': {
      if (servingViews) return { payload: { total: servingViews.total(op.options) } };
      if (op.options.view === 'all') return { payload: { total: await db.bookmarks.count() } };
      return { payload: { total: await db.bookmarks.where('folder').equals(op.options.folder).count() } };
    }
  }
}

/** Builds the export as a multi-part Blob without materializing the whole
 * library (or one giant string). */
async function exportRecords(format: 'json' | 'html', ids: number[] | undefined, progress: Progress): Promise<OpOutcome> {
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = format === 'json' ? `corral-backup-${stamp}.json` : `corral-bookmarks-${stamp}.html`;

  if (ids && ids.length > 0) {
    const records = await getRecordsByIds(ids, (read) => progress(`Reading ${count(read)}…`));
    const blob = format === 'json'
      ? new Blob(jsonParts(records.map((record) => JSON.stringify(record))), { type: 'application/json' })
      : new Blob(toNetscapeHtmlParts(records), { type: 'text/html' });
    return { payload: { blob, exported: records.length, filename } };
  }

  let exported = 0;
  if (format === 'json') {
    const parts: string[] = [];
    let lastId = 0;
    for (;;) {
      const records = await db.bookmarks.where('id').above(lastId).limit(INSERT_CHUNK).toArray();
      if (records.length === 0) break;
      lastId = records.at(-1)?.id ?? lastId;
      parts.push(records.map((record) => JSON.stringify(record)).join(',\n'));
      exported += records.length;
      progress(`Exported ${count(exported)}…`);
      await yieldToQueue();
    }
    return { payload: { blob: new Blob(jsonParts(parts), { type: 'application/json' }), exported, filename } };
  }

  // HTML: stream folder by folder, each folder fetched in bounded chunks.
  const folders = (await db.bookmarks.orderBy('folder').uniqueKeys()) as string[];
  const parts: string[] = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Corral Bookmarks</TITLE>\n<H1>Corral Bookmarks</H1>\n<DL><p>\n',
  ];
  for (const folder of folders) {
    const keys = (await db.bookmarks.where('folder').equals(folder).primaryKeys()) as number[];
    for (let offset = 0; offset < keys.length; offset += INSERT_CHUNK) {
      const chunk = await db.bookmarks.bulkGet(keys.slice(offset, offset + INSERT_CHUNK));
      const records = chunk.filter((record): record is BookmarkRecord => Boolean(record));
      parts.push(...toNetscapeHtmlParts(records).slice(1, -1));
      exported += records.length;
      progress(`Exported ${count(exported)}…`);
      await yieldToQueue();
    }
  }
  parts.push('</DL><p>\n');
  return { payload: { blob: new Blob(parts, { type: 'text/html' }), exported, filename } };
}

function jsonParts(recordParts: string[]) {
  const parts: string[] = [`{"format":"corral-bookmarks","version":1,"exportedAt":"${new Date().toISOString()}","records":[\n`];
  for (let index = 0; index < recordParts.length; index += 1) {
    parts.push(recordParts[index]!);
    if (index < recordParts.length - 1) parts.push(',\n');
  }
  parts.push('\n]}\n');
  return parts;
}

// --- favicon cache builder ---------------------------------------------------
// Runs outside the op chain: it never touches the bookmarks table, only the
// favicons store. Bumping `faviconRun` cancels the active pass at its next
// checkpoint; `fetchedAt` makes an interrupted pass resumable.

const FAVICON_CONCURRENCY = 8;
const FAVICON_TIMEOUT_MS = 8_000;
const FAVICON_MAX_BYTES = 1_048_576;

let faviconRun = 0;

async function decodeFavicon(response: Response) {
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (!response.ok || !contentType.startsWith('image/')) return null;
  const bytes = await response.blob();
  if (bytes.size === 0 || bytes.size > FAVICON_MAX_BYTES) return null;
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(bytes);
      bitmap.close();
    } catch {
      return null;
    }
  }
  return bytes;
}

async function fetchFavicon(source: FaviconSource, host: string, samples: string[]): Promise<FaviconRow> {
  const requestUrls = source.mode === 'chrome'
    ? chromeFaviconPageUrlCandidates(host, samples).map((pageUrl) => chromeFaviconUrl(source.prefix, pageUrl))
    : [previewFaviconUrl(source.prefix, host)];
  let hadError = false;
  for (const requestUrl of requestUrls) {
    try {
      // Accepted bytes live in IndexedDB. Failed responses must not poison
      // alternate candidates or the user's next retry.
      const response = await fetch(requestUrl, { signal: AbortSignal.timeout(FAVICON_TIMEOUT_MS), cache: 'no-store' });
      const bytes = await decodeFavicon(response);
      if (bytes) return { host, bytes, status: 'ok', fetchedAt: Date.now() };
      if (response.status >= 500) hadError = true;
    } catch {
      hadError = true;
    }
  }
  return { host, bytes: null, status: hadError ? 'error' : 'missing', fetchedAt: Date.now() };
}

/** Up to two real bookmark URLs per requested host. The URLs remain inside
 * the extension and are queried only through Chrome's local favicon API. */
async function faviconSamples(hosts: string[], run: number) {
  if (hosts.length === 0) return new Map<string, string[]>();
  const wanted = new Set(hosts);
  const samples = new Map<string, string[]>();
  let lastId = 0;
  for (;;) {
    const records = await db.bookmarks.where('id').above(lastId).limit(SCAN_CHUNK).toArray();
    if (records.length === 0) break;
    lastId = records.at(-1)?.id ?? lastId;
    for (const record of records) {
      if (!wanted.has(record.host)) continue;
      const list = samples.get(record.host) ?? [];
      if (!list.includes(record.url) && list.length < 2) list.push(record.url);
      samples.set(record.host, list);
    }
    if (run !== faviconRun) return null;
    await yieldToQueue();
  }
  return samples;
}

async function buildFavicons(source: FaviconSource) {
  const run = ++faviconRun;
  const views = servingViews;
  if (!views) {
    post({ type: 'favicon-progress', done: 0, total: 0, ok: 0, failed: 0, running: false, message: 'Still indexing — try again in a moment.' });
    return;
  }

  // Most-bookmarked hosts first. Explicit refreshes always retry failures;
  // successful icons keep their monthly freshness window.
  const now = Date.now();
  const ranked = views.hosts().filter((entry) => source.mode === 'chrome' || entry.host.includes('.')).map((entry) => entry.host);
  const pending: string[] = [];
  for (let offset = 0; offset < ranked.length; offset += INSERT_CHUNK) {
    const slice = ranked.slice(offset, offset + INSERT_CHUNK);
    const rows = await db.favicons.bulkGet(slice);
    for (let index = 0; index < slice.length; index += 1) {
      const row = rows[index];
      if (faviconNeedsFetch(row, now, source.retryFailures)) pending.push(slice[index]!);
    }
    if (run !== faviconRun) return;
    await yieldToQueue();
  }

  const samples = source.mode === 'chrome' ? await faviconSamples(pending, run) : new Map<string, string[]>();
  if (!samples || run !== faviconRun) return;
  const fetchable = source.mode === 'chrome'
    ? pending.filter((host) => chromeFaviconPageUrlCandidates(host, samples.get(host) ?? []).length > 0)
    : pending;
  const total = fetchable.length;
  let done = 0;
  let ok = 0;
  let failed = 0;
  let lastReport = -1;
  const report = (running: boolean) => {
    lastReport = done;
    post({ type: 'favicon-progress', done, total, ok, failed, running });
  };
  report(total > 0);

  for (let offset = 0; offset < fetchable.length; offset += FAVICON_CONCURRENCY) {
    if (run !== faviconRun) {
      report(false);
      return;
    }
    const rows = await Promise.all(fetchable.slice(offset, offset + FAVICON_CONCURRENCY).map((host) => fetchFavicon(source, host, samples.get(host) ?? [])));
    for (const row of rows) {
      if (row.status === 'ok') ok += 1;
      else failed += 1;
    }
    done += rows.length;
    await db.favicons.bulkPut(rows);
    if (done - lastReport >= 100) report(true);
    await yieldToQueue();
  }
  report(false);
}

const READ_ONLY_OPS = new Set(['folders', 'host-count', 'expand-host-selection', 'view-ids', 'view-total']);

/** Mutating ops run strictly serialized — a delete interleaving with a
 * streaming export would corrupt the export. Read-only ops answer instantly. */
let opChain: Promise<void> = Promise.resolve();

function handleOp(requestId: number, op: WorkerOp) {
  const run = async () => {
    try {
      const outcome = await runOp(op, (label) => post({ type: 'op-progress', requestId, label }));
      if (outcome.tombstoneIds && outcome.tombstoneIds.length > 0) applyTombstones(outcome.tombstoneIds);
      if (outcome.staleViews) servingViews = null;
      post({ type: 'op-done', requestId, payload: outcome.payload });
      if (outcome.rebuild) void rebuild();
    } catch (error) {
      post({ type: 'op-error', requestId, message: error instanceof Error ? error.message : 'The operation failed.' });
      if (!READ_ONLY_OPS.has(op.kind)) {
        // A failed mutation may have partially applied; fall back to live
        // reads and rescan rather than serving ghost rows.
        servingViews = null;
        void rebuild();
      }
    }
  };
  if (READ_ONLY_OPS.has(op.kind)) void run();
  else opChain = opChain.then(run);
}

const reportFatal = (error: unknown) => {
  post({ type: 'fatal', message: error instanceof Error ? error.message : 'The library could not be opened.' });
};

scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === 'init') void boot().catch(reportFatal);
  if (message.type === 'rebuild') void rebuild();
  if (message.type === 'search') runSearch(message.requestId, message.query, message.limit, message.folder);
  if (message.type === 'page') void readPage(message.requestId, message.options);
  if (message.type === 'op') handleOp(message.requestId, message.op);
  if (message.type === 'favicons') void buildFavicons(message.source);
  if (message.type === 'favicons-stop') faviconRun += 1;
};
