// Exercise the actual worker protocol, storage and rebuilds with isolated IDB.
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { db } from '../src/lib/db.ts';
import { parseBookmarkArchive, parseNetscapeHtml } from '../src/lib/import-export.ts';

let requestId = 0;
const pending = new Map();
const ready = [];
globalThis.self = {
  postMessage(message) {
    if (message.type === 'fatal') throw new Error(message.message);
    if (message.type === 'ready') ready.splice(0).forEach(resolve => resolve(message));
    const op = pending.get(message.requestId);
    if (!op) return;
    if (message.type === 'op-error') { pending.delete(message.requestId); op.reject(new Error(message.message)); }
    if (message.type === 'results') { pending.delete(message.requestId); op.resolve(message); }
    if (message.type === 'op-done') { pending.delete(message.requestId); op.resolve(message.payload); }
  },
};
await import('../src/lib/worker.ts');
const search = query => new Promise((resolve, reject) => {
  const id = ++requestId; pending.set(id, { resolve, reject });
  self.onmessage({ data: { type: 'search', requestId: id, query, limit: 100 } });
});
const nextReady = () => new Promise(resolve => ready.push(resolve));
const run = op => new Promise((resolve, reject) => {
  const id = ++requestId;
  pending.set(id, { resolve, reject });
  self.onmessage({ data: { type: 'op', requestId: id, op } });
});
const rebuildOp = async op => { const rebuilt = nextReady(); const result = await run(op); await rebuilt; return result; };
const options = { view: 'all', folder: '', subtree: false, sort: 'title', offset: 0, limit: 20 };
const timeout = setTimeout(() => { console.error('Worker integration timed out'); process.exit(1); }, 30000);
try {
  const boot = nextReady(); self.onmessage({ data: { type: 'init' } }); await boot;
  const { record } = await rebuildOp({ kind: 'save-bookmark', draft: { title: 'Original', url: 'https://first.example/path', folder: 'Research / Papers' } });
  assert.equal(record.source, 'manual');
  const { previous } = await rebuildOp({ kind: 'save-bookmark', id: record.id, draft: { title: 'Edited', url: 'https://second.example/new', folder: 'Reading' } });
  assert.equal(previous.title, 'Original');
  const edited = await db.bookmarks.get(record.id);
  assert.equal(edited.host, 'second.example');
  assert.deepEqual((await search('Original')).ids, []);
  assert.deepEqual((await search('Edited')).ids, [record.id]);
  assert.equal(edited.dateAdded, record.dateAdded);
  assert.equal(edited.importedAt, record.importedAt);
  assert.equal((await run({ kind: 'host-count', host: 'first.example' })).count, 0);
  assert.equal((await run({ kind: 'host-count', host: 'second.example' })).count, 1);
  assert.deepEqual((await run({ kind: 'view-ids', options })).ids, [record.id]);
  await assert.rejects(run({ kind: 'save-bookmark', id: record.id, draft: { ...edited, url: 'javascript:alert(1)' } }), /complete URL/);
  assert.equal((await db.bookmarks.get(record.id)).url, edited.url);
  await assert.rejects(run({ kind: 'save-bookmark', id: 99999, draft: edited }), /no longer exists/);

  await run({ kind: 'create-folder', path: 'Research / Empty' });
  await run({ kind: 'rename-folder', path: 'Research', newName: 'Projects' });
  assert((await run({ kind: 'folders' })).folders.some(f => f.folder === 'Projects / Empty'));
  await run({ kind: 'undo-relocate', path: 'Projects', newPath: 'Research' });
  assert((await run({ kind: 'folders' })).folders.some(f => f.folder === 'Research / Empty'));
  assert(!(await run({ kind: 'folders' })).folders.some(f => f.folder.startsWith('Projects')));
  await assert.rejects(run({ kind: 'rename-folder', path: 'Research', newName: 'Reading' }), /already exists/);

  // Full JSON and HTML backups include empty folders and genuine hierarchy.
  const json = await run({ kind: 'export', format: 'json' });
  const archive = parseBookmarkArchive(await json.blob.text());
  assert(archive.folders.includes('Research / Empty'));
  assert.equal(archive.records[0].importedAt, record.importedAt);
  const html = await run({ kind: 'export', format: 'html' });
  const paths = [];
  const parsed = parseNetscapeHtml(await html.blob.text(), paths);
  assert(paths.includes('Research / Empty'));
  assert.equal(parsed.length, 1);
  assert(!(await html.blob.text()).includes('<H3>Research / Empty</H3>'));
  await run({ kind: 'import-file', name: 'empty.json', text: JSON.stringify({ records: [], folders: ['Only / Empty'] }) });
  assert((await run({ kind: 'folders' })).folders.some(f => f.folder === 'Only / Empty'));
  await assert.rejects(run({ kind: 'import-file', name: 'bad.json', text: '{"unrelated":true}' }), /bookmark list/);

  // A single folder spanning export batches must be emitted exactly once.
  const many = Array.from({ length: 5100 }, (_, i) => ({ title: `Link ${i}`, url: `https://bulk.example/${i}`, folder: 'Bulk / Child', dateAdded: i + 1 }));
  await rebuildOp({ kind: 'import-file', name: 'many.json', text: JSON.stringify({ records: many }) });
  const large = await run({ kind: 'export', format: 'html' });
  const largeText = await large.blob.text();
  assert.equal(largeText.match(/<H3>Child<\/H3>/g).length, 1);
  assert.equal(parseNetscapeHtml(largeText).length, 5101);
  const moved = await run({ kind: 'rename-folder', path: 'Bulk', newName: 'Bulk renamed' });
  assert.equal(moved.moved, 5100);
  assert.equal((await search('Bulk renamed')).total, 5100);
  await run({ kind: 'undo-relocate', path: 'Bulk renamed', newPath: 'Bulk' });
  assert.equal(await db.bookmarks.where('folder').equals('Bulk / Child').count(), 5100);
  assert.equal((await search('Bulk renamed')).total, 0);
  console.log('worker integration: ALL PASS');
} finally { clearTimeout(timeout); db.close(); }
process.exit(0);
