// Search engine + view ordering tests.
// Usage: node scripts/test-engine.mjs   (Node 22.18+ strips TS types)

import { ShardBuilder, ShardStore, parseQuery } from '../src/lib/search-engine.ts';
import { ViewIndex, ViewIndexBuilder, serializeViewData, deserializeViewData } from '../src/lib/view-index.ts';

const assert = (cond, label) => {
  if (!cond) {
    console.error('FAIL:', label);
    process.exit(1);
  }
};

// --- search engine -----------------------------------------------------------
assert(parseQuery('to be or not to be hamlet').includes('hamlet'), 'dedupe before term cap');

const sb = new ShardBuilder();
sb.add({ id: 1, title: 'Hamlet study guide', url: 'https://shakespeare.org/hamlet', host: 'shakespeare.org', folder: 'Reading' });
sb.add({ id: 2, title: 'To be or not to be', url: 'https://quotes.example/tobe', host: 'quotes.example', folder: 'Reading' });
sb.add({ id: 3, title: 'Netflix queue', url: 'https://netflix.com/queue', host: 'netflix.com', folder: 'Media' });
const store = ShardStore.fromShards(sb.finish());
assert(store.search('flix', 10).ids.join(',') === '3', 'substring match');
assert(store.search('reading hamlet', 10).ids.join(',') === '1', 'multi-term AND');
store.tombstone([3]);
assert(store.search('flix', 10).ids.length === 0, 'tombstoned rows drop from search');

// --- view ordering -----------------------------------------------------------
// Folders: Work, Work / Deep, Play. Hosts: a.com, b.com.
const folderNames = ['Work', 'Work / Deep', 'Play'];
const hostNames = ['a.com', 'b.com'];
const vb = new ViewIndexBuilder();
// id, date, title, folderId, hostId
vb.add(1, 100, 'Alpha', 0, 0);
vb.add(2, 200, 'Bravo', 1, 1);
vb.add(3, 300, 'Charlie', 2, 0);
vb.add(4, 400, 'Delta', 0, 1);
vb.add(5, 500, 'Echo', 1, 0);
const index = new ViewIndex(vb.finish(folderNames, hostNames));

const q = (over = {}) => ({ view: 'all', folder: '', subtree: false, sort: 'newest', ...over });
assert(index.page(q(), 0, 10).ids.join(',') === '5,4,3,2,1', 'newest order');
assert(index.page(q({ sort: 'oldest' }), 0, 10).ids.join(',') === '1,2,3,4,5', 'oldest order');
assert(index.page(q({ sort: 'title' }), 0, 10).ids.join(',') === '1,2,3,4,5', 'title order');
assert(index.page(q({ sort: 'site' }), 0, 10).ids.join(',') === '1,3,5,2,4', 'site order (a.com then b.com, id asc)');

// Exact folder vs subtree.
assert(index.page(q({ view: 'folder', folder: 'Work' }), 0, 10).ids.join(',') === '4,1', 'exact folder');
assert(index.page(q({ view: 'folder', folder: 'Work', subtree: true }), 0, 10).ids.join(',') === '5,4,2,1', 'subtree folder');
assert(index.total(q({ view: 'folder', folder: 'Play' })) === 1, 'folder total');
assert(index.total(q({ view: 'folder', folder: 'Nope' })) === 0, 'unknown folder empty');
// 'Workshop' must NOT match the 'Work' subtree (prefix is 'Work / ').
const vb2 = new ViewIndexBuilder();
vb2.add(1, 1, 'A', 0, 0);
vb2.add(2, 2, 'B', 1, 0);
const index2 = new ViewIndex(vb2.finish(['Work', 'Workshop'], ['x.com']));
assert(index2.total({ view: 'folder', folder: 'Work', subtree: true, sort: 'newest' }) === 1, 'sibling prefix not swallowed by subtree');

// Aggregates.
const folders = index.folders();
assert(folders.length === 3 && folders[0].folder === 'Work' && folders[0].count === 2, 'folder counts');
assert(index.hostCount('a.com') === 3 && index.hostCount('nope.example') === 0, 'host counts');
assert(index.idsForHost('a.com').join(',') === '5,3,1', 'ids for host, newest first');

// Tombstones shrink everything.
index.tombstone([5]);
assert(index.page(q(), 0, 10).total === 4, 'tombstoned total');
assert(index.idsForHost('a.com').join(',') === '3,1', 'tombstoned host ids');
assert(index.hostCount('a.com') === 2, 'tombstoned host count');

// Persistence round trip + legacy-shape rejection.
const vb3 = new ViewIndexBuilder();
vb3.add(1, 100, 'A', 0, 0);
vb3.add(2, 200, 'B', 1, 1);
const data = vb3.finish(['One', 'Two'], ['a.com', 'b.com']);
const persisted = serializeViewData(data);
assert(typeof persisted.folderNames === 'string' && persisted.folderNames.includes('\u0000'), 'names joined');
const revived = deserializeViewData(persisted);
assert(revived && revived.folderNames.join(',') === 'One,Two', 'round trip');
assert(new ViewIndex(revived).page(q(), 0, 5).ids.join(',') === '2,1', 'revived index pages');
assert(deserializeViewData({ ...persisted, folderNames: ['One'] }) === null, 'legacy array shape rejected');
const missing = { ...persisted };
delete missing.hostCounts;
assert(deserializeViewData(missing) === null, 'missing counts rejected');
assert(deserializeViewData(undefined) === null, 'absent row rejected');

console.log('engine tests: ALL PASS');
