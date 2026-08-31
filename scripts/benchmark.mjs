// Benchmarks Corral's shard-scan search engine on a synthetic library.
// Usage: node --expose-gc scripts/benchmark.mjs [recordCount]
// (Node 22.18+ strips the TypeScript types from the imported engine.)

import { ShardBuilder, ShardStore } from '../src/lib/search-engine.ts';
import { ViewIndex, ViewIndexBuilder } from '../src/lib/view-index.ts';

const count = Number.parseInt(process.argv[2] ?? '500000', 10);
if (!Number.isSafeInteger(count) || count < 1) throw new Error('Pass a positive record count.');

const buildStarted = performance.now();
const builder = new ShardBuilder();
for (let id = 1; id <= count; id += 1) {
  const project = id % 100_000;
  const domain = id % 10_000;
  builder.add({
    id,
    title: `Bookmark ${id} project ${project}`,
    url: `https://domain${domain}.example.com/articles/${id}?ref=queue`,
    host: `domain${domain}.example.com`,
    folder: `Research / Batch ${id % 250}`,
  });
}
const store = ShardStore.fromShards(builder.finish());
const buildMs = performance.now() - buildStarted;
global.gc?.();

const timings = [];
for (let run = 0; run < 60; run += 1) {
  const started = performance.now();
  const result = store.search(`project ${10_000 + (run * 977) % 80_000}`, 5_000);
  timings.push(performance.now() - started);
  if (result.ids.length === 0) throw new Error(`Search ${run + 1} unexpectedly returned no results.`);
}

const substringTimings = [];
for (let run = 0; run < 30; run += 1) {
  const started = performance.now();
  store.search(`rticles/${1_000 + run * 313}`, 5_000);
  substringTimings.push(performance.now() - started);
}

// The view ordering that replaced O(offset) cursor paging: build it the way
// the worker does, then page at brutal depths across every sort and filter.
// Hosts are realistic: ~85% of bookmarks live on their own unique host.
const viewBuildStarted = performance.now();
const folderNames = Array.from({ length: 251 }, (_, i) => (i === 0 ? 'Unsorted' : `Research / Batch ${i - 1}`));
const hostNames = Array.from({ length: 40 }, (_, i) => `popular${i}.example.com`);
const hostIdFor = Array.from({ length: count }, () => 0);
for (let id = 1; id <= count; id += 1) {
  if (id % 7 === 0) hostIdFor[id - 1] = id % 40; // popular pool
  else {
    hostIdFor[id - 1] = hostNames.length;
    hostNames.push(`unique-host-${id}.example.org`);
  }
}
const viewBuilder = new ViewIndexBuilder();
for (let id = 1; id <= count; id += 1) {
  viewBuilder.add(id, 1_700_000_000_000 + id * 1_000, `Bookmark ${id} project ${id % 100_000}`, id % 17 === 0 ? 0 : 1 + (id % 250), hostIdFor[id - 1]);
}
const viewIndex = new ViewIndex(viewBuilder.finish(folderNames, hostNames));
const viewBuildMs = performance.now() - viewBuildStarted;

const sidebarStarted = performance.now();
const folders = viewIndex.folders();
const hostBookmarks = viewIndex.idsForHost('popular3.example.com');
const sidebarMs = performance.now() - sidebarStarted;
if (folders.length === 0 || hostBookmarks.length === 0) throw new Error('Sidebar aggregates unexpectedly empty.');
global.gc?.();

const pageTimings = [];
const pageQueries = [
  { view: 'all', folder: '', subtree: false, sort: 'newest' },
  { view: 'all', folder: '', subtree: false, sort: 'title' },
  { view: 'all', folder: '', subtree: false, sort: 'site' },
  { view: 'folder', folder: 'Research / Batch 9', subtree: false, sort: 'newest' },
  { view: 'folder', folder: 'Research', subtree: true, sort: 'newest' },
  { view: 'all', folder: '', subtree: false, sort: 'oldest' },
];
for (let run = 0; run < 60; run += 1) {
  const q = pageQueries[run % pageQueries.length];
  const total = viewIndex.total(q);
  const offset = Math.max(0, Math.floor(total * 0.8) + run);
  const started = performance.now();
  const page = viewIndex.page(q, offset, 240);
  pageTimings.push(performance.now() - started);
  if (total > 240 && page.ids.length === 0) throw new Error(`Deep page unexpectedly empty for ${q.view}/${q.sort}.`);
}

const percentile = (values, share) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
};
const heapMb = process.memoryUsage().heapUsed / 1_048_576;

console.log(JSON.stringify({
  records: count,
  buildSeconds: Number((buildMs / 1_000).toFixed(2)),
  documentsPerSecond: Math.round(count / (buildMs / 1_000)),
  searchP50Ms: Number(percentile(timings, 0.5).toFixed(3)),
  searchP95Ms: Number(percentile(timings, 0.95).toFixed(3)),
  substringP50Ms: Number(percentile(substringTimings, 0.5).toFixed(3)),
  substringP95Ms: Number(percentile(substringTimings, 0.95).toFixed(3)),
  uniqueHosts: hostNames.length,
  viewOrderBuildSeconds: Number((viewBuildMs / 1_000).toFixed(2)),
  sidebarAggregatesMs: Number(sidebarMs.toFixed(1)),
  deepPageP50Ms: Number(percentile(pageTimings, 0.5).toFixed(3)),
  deepPageP95Ms: Number(percentile(pageTimings, 0.95).toFixed(3)),
  heapUsedMb: Number(heapMb.toFixed(1)),
}, null, 2));
