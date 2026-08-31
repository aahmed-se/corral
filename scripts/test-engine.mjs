// Search engine + view ordering tests.
// Usage: node scripts/test-engine.mjs   (Node 22.18+ strips TS types)

import { ShardBuilder, ShardStore, parseQuery } from '../src/lib/search-engine.ts';
import { buildTree, findTreeNode } from '../src/lib/folder-tree.ts';
import {
  chromeFaviconPageUrlCandidates,
  chromeFaviconUrl,
  faviconNeedsFetch,
  FAVICON_ERROR_RETRY_MS,
  FAVICON_MISSING_RETRY_MS,
  previewFaviconUrl,
} from '../src/lib/favicon-cache.ts';
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
const allHostExpansion = index.hostExpansion([2, 3], q());
assert(allHostExpansion.hosts.join(',') === 'a.com,b.com', 'host expansion reports selected base hosts');
assert(allHostExpansion.ids.join(',') === '1,2,3,4,5', 'host expansion selects every matching base host');
const folderHostExpansion = index.hostExpansion([1], q({ view: 'folder', folder: 'Work', subtree: true }));
assert(folderHostExpansion.ids.join(',') === '1,5', 'host expansion stays inside the folder subtree');
const exactFolderHostExpansion = index.hostExpansion([1], q({ view: 'folder', folder: 'Work' }));
assert(exactFolderHostExpansion.ids.join(',') === '1', 'host expansion respects an exact folder scope');
assert(index.hostExpansion([999], q()).ids.length === 0, 'host expansion ignores unknown members');

// Tombstones shrink everything.
index.tombstone([5]);
assert(index.page(q(), 0, 10).total === 4, 'tombstoned total');
assert(index.idsForHost('a.com').join(',') === '3,1', 'tombstoned host ids');
assert(index.hostCount('a.com') === 2, 'tombstoned host count');
assert(index.hostExpansion([1], q()).ids.join(',') === '1,3', 'tombstones shrink host expansion');

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

// --- file-explorer folder rows --------------------------------------------------
const tree = buildTree([
  { folder: 'Work', count: 2 },
  { folder: 'Work / Deep / Archive', count: 3 },
  { folder: 'Work / Peer', count: 1 },
]);
const workNode = findTreeNode(tree, 'Work');
assert(workNode && workNode.total === 6, 'folder tree rolls up descendant links');
assert(workNode.children.map((node) => node.path).join(',') === 'Work / Deep,Work / Peer', 'folder view exposes only immediate children');
assert(workNode.children[0].total === 3 && workNode.children[0].own === 0, 'missing intermediate folder is synthesized');
assert(findTreeNode(tree, 'Work / Deep / Archive')?.own === 3, 'nested folder remains addressable');

// --- favicon cache policy + local Chrome URL candidates ------------------------
const faviconNow = 2_000_000_000_000;
const faviconRow = (status, age) => ({ host: 'example.com', bytes: status === 'ok' ? new Blob(['x']) : null, status, fetchedAt: faviconNow - age });
assert(!faviconNeedsFetch(faviconRow('ok', 1_000), faviconNow, true), 'manual refresh preserves fresh successful icons');
assert(faviconNeedsFetch(faviconRow('missing', 1_000), faviconNow, true), 'manual refresh retries recent missing icons');
assert(faviconNeedsFetch(faviconRow('error', 1_000), faviconNow, true), 'manual refresh retries recent errors');
assert(!faviconNeedsFetch(faviconRow('missing', FAVICON_MISSING_RETRY_MS - 1), faviconNow, false), 'missing result has a short automatic cooldown');
assert(faviconNeedsFetch(faviconRow('error', FAVICON_ERROR_RETRY_MS + 1), faviconNow, false), 'transient errors retry after cooldown');
const faviconCandidates = chromeFaviconPageUrlCandidates('example.com', ['http://www.example.com/saved/page', 'chrome://settings/']);
assert(faviconCandidates[0] === 'http://www.example.com/saved/page', 'real bookmarked URL is the first Chrome favicon candidate');
assert(faviconCandidates.includes('http://www.example.com/') && faviconCandidates.includes('https://example.com/'), 'origin and scheme fallbacks are retained');
assert(chromeFaviconPageUrlCandidates('chrome', ['chrome://settings/']).length === 0, 'non-web bookmarks never trigger Chrome favicon requests');
const chromeFaviconRequest = new URL(chromeFaviconUrl('chrome-extension://abc/_favicon/', 'http://www.example.com/saved/page'));
assert(chromeFaviconRequest.searchParams.get('pageUrl') === 'http://www.example.com/saved/page' && chromeFaviconRequest.searchParams.get('size') === '32', 'Chrome request carries the actual page URL');
assert(previewFaviconUrl('/s2-favicon?domain=', 'example.com') === '/s2-favicon?domain=example.com', 'external preview request contains only the host');

// --- scoped search (accept predicate) ------------------------------------------
const sb2 = new ShardBuilder();
sb2.add({ id: 11, title: 'GitHub home', url: 'https://github.com/', host: 'github.com', folder: 'Dev' });
sb2.add({ id: 12, title: 'GitHub docs', url: 'https://docs.github.com/', host: 'docs.github.com', folder: 'Dev / Docs' });
sb2.add({ id: 13, title: 'GitHub blog', url: 'https://github.blog/', host: 'github.blog', folder: 'News' });
const scopedStore = ShardStore.fromShards(sb2.finish());
assert(scopedStore.search('github', 10).total === 3, 'unscoped finds all');
const devMembers = new Set([11, 12]);
const scoped = scopedStore.search('github', 10, (id) => devMembers.has(id));
assert(scoped.ids.length === 2 && scoped.total === 2 && !scoped.ids.includes(13), 'scope filters matches');
const none = scopedStore.search('github', 10, () => false);
assert(none.ids.length === 0 && none.total === 0 && none.truncated === false, 'empty scope');

// The predicate runs inside the match loop, so a tiny folder is reachable even
// when a common term would truncate the unscoped scan before its shard.
const sb3 = new ShardBuilder();
sb3.add({ id: 90001, title: 'Common treasure', url: 'https://rare.example/x', host: 'rare.example', folder: 'Tiny' });
for (let i = 1; i <= 30000; i += 1) {
  sb3.add({ id: i, title: `Common page ${i}`, url: `https://common.example/${i}`, host: 'common.example', folder: 'Noise' });
}
const bigStore = ShardStore.fromShards(sb3.finish());
const unscopedBig = bigStore.search('common', 50);
assert(unscopedBig.truncated && !unscopedBig.ids.includes(90001), 'sanity: unscoped scan truncates before the oldest shard');
const tinyScope = bigStore.search('common', 50, (id) => id === 90001);
assert(tinyScope.ids.join(',') === '90001' && tinyScope.total === 1, 'small scope survives a common term');

// --- folder membership sets + host ranking --------------------------------------
const vbm = new ViewIndexBuilder();
vbm.add(1, 10, 'A', 0, 0); // Work
vbm.add(2, 20, 'B', 1, 0); // Work / Deep
vbm.add(3, 30, 'C', 2, 1); // Play
const memberIndex = new ViewIndex(vbm.finish(['Work', 'Work / Deep', 'Play'], ['a.com', 'b.com']));
assert([...memberIndex.folderMemberSet('Work')].sort().join(',') === '1,2', 'membership includes subtree');
assert(memberIndex.folderMemberSet('Play').has(3) && memberIndex.folderMemberSet('Play').size === 1, 'membership exact folder');
assert(memberIndex.folderMemberSet('Nope').size === 0, 'membership unknown folder');
memberIndex.tombstone([2]);
assert(memberIndex.folderMemberSet('Work').size === 1, 'tombstone shrinks membership');
const rankedHosts = memberIndex.hosts();
assert(rankedHosts[0].host === 'a.com' && rankedHosts[0].count === 2, 'hosts ranked by count');

console.log('engine tests: ALL PASS');
