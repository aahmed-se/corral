import assert from 'node:assert/strict';
import { indexTree, duplicateIds, runBatch, openableUrl, exportTreeHtml } from '../bookmark-os/core.js';
import { parseNetscapeHtml } from '../src/lib/import-export.ts';
import { readFile } from 'node:fs/promises';

const tree = [{ id: '0', children: [{ id: '1', parentId: '0', title: 'Bar', children: [
  { id: '2', parentId: '1', title: 'Nested', children: [
    { id: '3', parentId: '2', index: 0, title: 'A & B', url: 'https://example.com/?a=1&b=2', dateAdded: 2000 },
    { id: '4', parentId: '2', index: 1, title: 'Older', url: 'https://example.com/?a=1&b=2', dateAdded: 1000 },
  ] },
  { id: '5', parentId: '1', title: 'Empty', children: [] },
] }] }];
const indexed = indexTree(tree);
assert.deepEqual(indexed.rootIds, ['1']);
assert.equal(indexed.folders['1'].total, 2);
assert.equal(indexed.folders['2'].count, 2);
assert.equal(indexed.bookmarks[0].path, 'Bar › Nested');
assert.equal(indexed.domainMap['example.com'], 2);
assert.deepEqual(duplicateIds(indexed.bookmarks), ['3']);
assert.equal(openableUrl('javascript:alert(1)'), null);
assert.equal(openableUrl('data:text/html,bad'), null);
assert.equal(openableUrl('https://example.com'), 'https://example.com');
const paths = [];
const parsed = parseNetscapeHtml(exportTreeHtml(tree).join(''), paths);
assert.equal(parsed[0].title, 'A & B');
assert.equal(parsed[0].folder, 'Bar / Nested');
assert(paths.includes('Bar / Empty'));

let inFlight = 0, peak = 0;
const batch = await runBatch(Array.from({ length: 40 }, (_, i) => i), async i => {
  inFlight++; peak = Math.max(peak, inFlight);
  await new Promise(resolve => setTimeout(resolve, 1));
  inFlight--;
  if (i % 7 === 0) throw new Error('Chrome rejected this change');
});
assert(peak <= 8);
assert.equal(batch.succeeded.length, 34);
assert.equal(batch.failed.length, 6);
assert(batch.failed.every(({ message }) => message.includes('Chrome rejected')));
const manifest = JSON.parse(await readFile(new URL('../bookmark-os/manifest.json', import.meta.url)));
assert(manifest.permissions.includes('favicon'));
assert(!manifest.permissions.includes('tabs'));
const css = await readFile(new URL('../bookmark-os/app.css', import.meta.url), 'utf8');
const app = await readFile(new URL('../bookmark-os/app.js', import.meta.url), 'utf8');
assert(!css.includes('@import'));
assert(!app.includes('google.com/s2'));
assert(!app.includes('onerror='));
console.log('Bookmark OS tests: ALL PASS');
