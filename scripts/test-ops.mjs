// Data-layer op tests against an in-memory IndexedDB. The worker module
// itself needs a WorkerGlobalScope, so this exercises the same db.ts
// primitives its ops are built from, plus the corral-by-host id selection.
// Usage: node scripts/test-ops.mjs

import 'fake-indexeddb/auto';

const { db, makeRecord, moveToFolder, deleteByIds, getRecordsByIds, addRecordsInBatches, getFallbackPage, markLibraryDirty, getDirtyRevision } =
  await import('../src/lib/db.ts');
const { ViewIndex, ViewIndexBuilder } = await import('../src/lib/view-index.ts');

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
await deleteByIds(victims);
assert((await db.bookmarks.count()) === 850, 'delete applied');

const page = await getFallbackPage({ view: 'all', folder: '', subtree: false, sort: 'newest', offset: 0, limit: 100 });
assert(page.length === 100, 'fallback page');
const workPage = await getFallbackPage({ view: 'folder', folder: 'Work / Deep', subtree: false, sort: 'newest', offset: 0, limit: 10 });
assert(workPage.every((record) => record.folder === 'Work / Deep'), 'fallback folder page');
const subtreePage = await getFallbackPage({ view: 'folder', folder: 'Work', subtree: true, sort: 'newest', offset: 0, limit: 10 });
assert(subtreePage.every((record) => record.folder.startsWith('Work')), 'fallback subtree page');

console.log('ops tests: ALL PASS');
process.exit(0);
