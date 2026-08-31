/// <reference lib="webworker" />

// Corral's engine worker. All data work happens here — the UI thread only
// renders and talks to the chrome.* APIs. One streamed pass over the
// bookmarks table builds the search shards, the view ordering, and the
// folder/host counts together, with progress for every phase; the previous
// index keeps serving while a rebuild runs.

import {
  db,
  deleteByIds,
  getDirtyRevision,
  getFallbackPage,
  getRecordsByIds,
  makeRecord,
  markLibraryDirty,
  moveToFolder,
  sanitizeName,
  UNFILED,
  type BookmarkRecord,
  type FolderCount,
  type LibraryStats,
  type ShardRow,
  type ViewOptions,
} from './db.ts';
import { parseBookmarkJson, parseNetscapeHtml, toNetscapeHtmlParts, type RawBookmarkInput } from './import-export.ts';
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
  // Read-only:
  | { kind: 'folders' }
  | { kind: 'host-count'; host: string }
  | { kind: 'view-ids'; options: ViewOptions }
  | { kind: 'view-total'; options: ViewOptions };

export type IndexPhase = 'scanning' | 'analyzing' | 'saving';

export type WorkerRequest =
  | { type: 'init' }
  | { type: 'rebuild' }
  | { type: 'search'; requestId: number; query: string; limit: number }
  | { type: 'page'; requestId: number; options: ViewOptions }
  | { type: 'op'; requestId: number; op: WorkerOp };

export type WorkerResponse =
  | { type: 'phase'; phase: IndexPhase; done: number; total: number }
  | { type: 'ready'; stats: LibraryStats; restored: boolean }
  | { type: 'results'; requestId: number; ids: number[]; total: number; truncated: boolean; elapsedMs: number }
  | { type: 'page'; requestId: number; rows: Array<BookmarkRecord | undefined>; total?: number }
  | { type: 'page-error'; requestId: number; message: string }
  | { type: 'op-progress'; requestId: number; label: string }
  | { type: 'op-done'; requestId: number; payload?: unknown }
  | { type: 'op-error'; requestId: number; message: string }
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

function runSearch(requestId: number, query: string, limit: number) {
  const started = performance.now();
  const result = serving ? serving.search(query, limit) : { ids: [], total: 0, truncated: false };
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

    case 'folders': {
      const folders: FolderCount[] = servingViews ? servingViews.folders() : [];
      return { payload: { folders, stale: !servingViews } };
    }

    case 'host-count':
      return { payload: { count: servingViews ? servingViews.hostCount(op.host) : 0 } };

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

const READ_ONLY_OPS = new Set(['folders', 'host-count', 'view-ids', 'view-total']);

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
  if (message.type === 'search') runSearch(message.requestId, message.query, message.limit);
  if (message.type === 'page') void readPage(message.requestId, message.options);
  if (message.type === 'op') handleOp(message.requestId, message.op);
};
