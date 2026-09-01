// Data-layer op tests against an in-memory IndexedDB. The worker module
// itself needs a WorkerGlobalScope, so this exercises the same db.ts
// primitives its ops are built from, plus the corral-by-host id selection.
// Usage: node scripts/test-ops.mjs

import 'fake-indexeddb/auto';
import Dexie from 'dexie';

const { db, makeRecord, moveToFolder, deleteByIds, getRecordsByIds, addRecordsInBatches, getFallbackPage, markLibraryDirty, getDirtyRevision, getExtraFolders, setExtraFolders } =
  await import('../src/lib/db.ts');
const { ViewIndex, ViewIndexBuilder } = await import('../src/lib/view-index.ts');
const { FAVICON_MAX_BYTES, readFaviconBytes } = await import('../src/lib/favicon-cache.ts');

const assert = (cond, label) => {
  if (!cond) {
    console.error('FAIL:', label);
    process.exit(1);
  }
};

// Seed: 3 folders, some shared hosts.
const seed = [];
for (let i = 1; i <= 900; i += 1) {
  seed.push(makeRecord({
    title: `Bookmark ${i}`,
    url: `https://${i % 3 === 0 ? 'shared.example.com' : `site${i}.example.org`}/page/${i}`,
    folder: i % 2 === 0 ? 'Work / Deep' : 'Reading',
    dateAdded: 1_700_000_000_000 + i * 1000,
    source: 'json',
  }));
}
await addRecordsInBatches(seed);
assert((await db.bookmarks.count()) === 900, 'seeded');
assert(!db.bookmarks.schema.indexes.some((index) => index.name === 'source'), 'dead source index removed without losing rows');

// A real v1 database upgrades through every production schema version. The
// v4 index removal must retain records and the remaining folder index.
const upgradeName = 'corral-v1-to-v4-test';
const legacyDb = new Dexie(upgradeName);
legacyDb.version(1).stores({ bookmarks: '++id, source, folder', meta: '&key', searchShards: '&seq, revision', viewData: '&revision' });
await legacyDb.open();
await legacyDb.table('bookmarks').add(seed[0]);
legacyDb.close();
const upgradedDb = new Dexie(upgradeName);
upgradedDb.version(1).stores({ bookmarks: '++id, source, folder', meta: '&key', searchShards: '&seq, revision', viewData: '&revision' });
upgradedDb.version(2).stores({ favicons: '&host, fetchedAt' });
upgradedDb.version(3).stores({ favicons: '&host, status, fetchedAt' });
upgradedDb.version(4).stores({ bookmarks: '++id, folder' });
await upgradedDb.open();
assert((await upgradedDb.table('bookmarks').count()) === 1, 'v1 to v4 upgrade retains bookmark rows');
assert(!upgradedDb.table('bookmarks').schema.indexes.some((index) => index.name === 'source'), 'v1 to v4 upgrade drops only source index');
assert(upgradedDb.table('bookmarks').schema.indexes.some((index) => index.name === 'folder'), 'v1 to v4 upgrade retains folder index');
await upgradedDb.delete();

// Build a view index the way the worker's scan does.
const folderIds = new Map();
const hostIds = new Map();
const folderNames = [];
const hostNames = [];
const vb = new ViewIndexBuilder();
for (const record of await db.bookmarks.toArray()) {
  let folderId = folderIds.get(record.folder);
  if (folderId === undefined) {
    folderId = folderNames.length;
    folderIds.set(record.folder, folderId);
    folderNames.push(record.folder);
  }
  let hostId = hostIds.get(record.host);
  if (hostId === undefined) {
    hostId = hostNames.length;
    hostIds.set(record.host, hostId);
    hostNames.push(record.host);
  }
  vb.add(record.id, record.dateAdded, record.title, folderId, hostId);
}
const index = new ViewIndex(vb.finish(folderNames, hostNames));

// Corral by host: collect ids, move them, verify.
const sharedIds = index.idsForHost('shared.example.com');
assert(sharedIds.length === 300, `host id collection, got ${sharedIds.length}`);
const before = await getRecordsByIds(sharedIds);
const priorFolders = before.map((record) => ({ id: record.id, folder: record.folder }));
const moved = await moveToFolder(sharedIds, 'Corralled / shared.example.com');
assert(moved === 300, 'corral moves every host record');
const after = await getRecordsByIds(sharedIds);
assert(after.every((record) => record.folder === 'Corralled / shared.example.com'), 'destination applied');

// Undo restores prior folders exactly.
for (const { id, folder } of priorFolders) {
  const record = after.find((row) => row.id === id);
  assert(record, 'moved record still present');
  record.folder = folder;
}
await db.bookmarks.bulkPut(after);
const restored = await getRecordsByIds(sharedIds);
assert(restored.filter((record) => record.folder === 'Reading').length === priorFolders.filter((p) => p.folder === 'Reading').length, 'undo restores folders');

// Delete + fallback paging.
const victims = restored.slice(0, 50).map((record) => record.id);
await markLibraryDirty();
const dirtyBefore = await getDirtyRevision();
assert(dirtyBefore > 0, 'dirty token set');
await markLibraryDirty();
assert((await getDirtyRevision()) > dirtyBefore, 'dirty token increases monotonically');
await deleteByIds(victims);
assert((await db.bookmarks.count()) === 850, 'delete applied');

const page = await getFallbackPage({ view: 'all', folder: '', subtree: false, sort: 'newest', offset: 0, limit: 100 });
assert(page.length === 100, 'fallback page');
const workPage = await getFallbackPage({ view: 'folder', folder: 'Work / Deep', subtree: false, sort: 'newest', offset: 0, limit: 10 });
assert(workPage.every((record) => record.folder === 'Work / Deep'), 'fallback folder page');
const subtreePage = await getFallbackPage({ view: 'folder', folder: 'Work', subtree: true, sort: 'newest', offset: 0, limit: 10 });
assert(subtreePage.every((record) => record.folder.startsWith('Work')), 'fallback subtree page');

// Extra (record-less) folders: deduped, sorted, retrievable.
assert((await getExtraFolders()).length === 0, 'no extras initially');
await setExtraFolders(['Projects / Ideas', 'Archive', 'Projects / Ideas']);
assert((await getExtraFolders()).join('|') === 'Archive|Projects / Ideas', 'extras deduped and sorted');

// Favicon status is indexed so the UI can count only successful cached icons.
await db.favicons.bulkPut([
  { host: 'ok.example', bytes: new Blob(['icon']), status: 'ok', fetchedAt: Date.now() },
  { host: 'missing.example', bytes: null, status: 'missing', fetchedAt: Date.now() },
]);
assert((await db.favicons.where('status').equals('ok').count()) === 1, 'favicon success count excludes missing rows');

// Chrome's extension-local favicon response may omit Content-Type. Usable
// opaque bytes must still be cached, while empty/failed/oversized bodies are not.
assert((await readFaviconBytes(new Response(new Blob(['icon']))))?.size === 4, 'favicon bytes work without image MIME metadata');
assert((await readFaviconBytes(new Response(null, { status: 204 }))) === null, 'empty favicon response rejected');
assert((await readFaviconBytes(new Response('no', { status: 404 }))) === null, 'failed favicon response rejected');
assert((await readFaviconBytes(new Response(new Blob([new Uint8Array(FAVICON_MAX_BYTES + 1)])))) === null, 'oversized favicon response rejected');

// Duplicate detection keys on the normalized URL stored at import time.
const dupA = makeRecord({ title: 'Dup', url: 'https://Example.com/page/?utm_source=x#frag', folder: 'X', dateAdded: 1, source: 'json' });
const dupB = makeRecord({ title: 'Dup again', url: 'https://example.com/page', folder: 'Y', dateAdded: 2, source: 'json' });
assert(dupA.normalizedUrl === dupB.normalizedUrl, 'tracking params, fragments, and case unify');
const distinct = makeRecord({ title: 'Different', url: 'https://example.com/page?id=2', folder: 'Y', dateAdded: 3, source: 'json' });
assert(distinct.normalizedUrl !== dupA.normalizedUrl, 'meaningful query params stay distinct');

console.log('ops tests: ALL PASS');
process.exit(0);
