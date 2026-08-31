// In-memory row ordering and aggregates for every list view.
//
// IndexedDB cursors answer "the next record after key X" quickly, but "the
// 300,000th record in this ordering" only by walking 300,000 index entries.
// This module makes the worker the source of row ORDER instead: the rebuild
// scan captures compact parallel arrays plus one sort permutation per sort
// mode, so a page at any scroll depth is an O(page) array slice followed by a
// primary-key bulkGet. Folder counts, host counts, and host membership are
// answered from the same arrays — nothing persisted scales with the number of
// unique hosts.
//
// Dependency-free so the worker and the Node tests/benchmark share it.

export type ViewSort = 'newest' | 'oldest' | 'title' | 'site';

export type ViewQuery = {
  view: 'all' | 'folder';
  folder: string;
  /** When true, a folder view includes every descendant folder. */
  subtree: boolean;
  sort: ViewSort;
};

export type ViewIndexData = {
  /** Record ids in scan (primary-key) order; all other arrays are parallel. */
  ids: Uint32Array;
  dates: Float64Array;
  folderIdOf: Uint32Array;
  hostIdOf: Uint32Array;
  /** Positions into `ids`, sorted ascending by (dateAdded, id). */
  byDate: Uint32Array;
  /** Positions into `ids`, sorted ascending by (title, id), code-unit order. */
  byTitle: Uint32Array;
  /** Positions into `ids`, sorted ascending by (host, id). */
  byHost: Uint32Array;
  /** Record count per folderId / hostId. */
  folderCounts: Uint32Array;
  hostCounts: Uint32Array;
  folderNames: string[];
  hostNames: string[];
};

export type FolderCount = { folder: string; count: number };

/** Separator for persisted name lists — control characters are stripped from
 * names at record creation and at index time, so it cannot occur in one. */
export const NAME_SEPARATOR = '\u0000';

export const FOLDER_SEPARATOR = ' / ';

/** ViewIndexData with the name lists flattened for persistence: cloning two
 * big strings is much faster than hundreds of thousands of small ones. */
export type PersistedViewData = Omit<ViewIndexData, 'folderNames' | 'hostNames'> & {
  folderNames: string;
  hostNames: string;
};

export function serializeViewData(data: ViewIndexData): PersistedViewData {
  return {
    ...data,
    folderNames: data.folderNames.join(NAME_SEPARATOR),
    hostNames: data.hostNames.join(NAME_SEPARATOR),
  };
}

/** Returns null for rows persisted by other schema shapes — the caller
 * rebuilds instead. Crashing on an upgraded database is not an option. */
export function deserializeViewData(row: unknown): ViewIndexData | null {
  if (typeof row !== 'object' || row === null) return null;
  const candidate = row as Record<string, unknown>;
  const uint32Fields = ['ids', 'folderIdOf', 'hostIdOf', 'byDate', 'byTitle', 'byHost', 'folderCounts', 'hostCounts'] as const;
  for (const field of uint32Fields) {
    if (!(candidate[field] instanceof Uint32Array)) return null;
  }
  if (!(candidate.dates instanceof Float64Array)) return null;
  if (typeof candidate.folderNames !== 'string' || typeof candidate.hostNames !== 'string') return null;
  const persisted = row as PersistedViewData;
  return {
    ...persisted,
    folderNames: persisted.folderNames === '' ? [] : persisted.folderNames.split(NAME_SEPARATOR),
    hostNames: persisted.hostNames === '' ? [] : persisted.hostNames.split(NAME_SEPARATOR),
  };
}

const VIEW_CACHE_LIMIT = 8;

export class ViewIndexBuilder {
  private ids: number[] = [];
  private dates: number[] = [];
  private folderIds: number[] = [];
  private hostIds: number[] = [];
  private titles: string[] = [];

  add(id: number, dateAdded: number, title: string, folderId: number, hostId: number) {
    this.ids.push(id);
    this.dates.push(dateAdded);
    this.folderIds.push(folderId);
    this.hostIds.push(hostId);
    this.titles.push(title);
  }

  /** Computes the sort permutations and releases the transient title strings.
   * The three sorts are the only O(n log n) work in a rebuild. */
  finish(folderNames: string[], hostNames: string[]): ViewIndexData {
    const count = this.ids.length;
    const ids = Uint32Array.from(this.ids);
    const dates = Float64Array.from(this.dates);
    const folderIdOf = Uint32Array.from(this.folderIds);
    const hostIdOf = Uint32Array.from(this.hostIds);
    const titles = this.titles;

    const permutation = () => {
      const positions = new Uint32Array(count);
      for (let index = 0; index < count; index += 1) positions[index] = index;
      return positions;
    };

    const byDate = permutation();
    byDate.sort((left, right) => dates[left]! - dates[right]! || ids[left]! - ids[right]!);

    const byTitle = permutation();
    byTitle.sort((left, right) => {
      const a = titles[left]!;
      const b = titles[right]!;
      if (a < b) return -1;
      if (a > b) return 1;
      return ids[left]! - ids[right]!;
    });

    const hostRank = rankNames(hostNames);
    const byHost = permutation();
    byHost.sort((left, right) => hostRank[hostIdOf[left]!]! - hostRank[hostIdOf[right]!]! || ids[left]! - ids[right]!);

    const folderCounts = new Uint32Array(folderNames.length);
    const hostCounts = new Uint32Array(hostNames.length);
    for (let index = 0; index < count; index += 1) {
      const folderId = folderIdOf[index]!;
      const hostId = hostIdOf[index]!;
      folderCounts[folderId] = (folderCounts[folderId] ?? 0) + 1;
      hostCounts[hostId] = (hostCounts[hostId] ?? 0) + 1;
    }

    this.ids = [];
    this.dates = [];
    this.folderIds = [];
    this.hostIds = [];
    this.titles = [];

    return { ids, dates, folderIdOf, hostIdOf, byDate, byTitle, byHost, folderCounts, hostCounts, folderNames, hostNames };
  }
}

function rankNames(names: string[]) {
  const order = names.map((_, index) => index).sort((left, right) => (names[left]! < names[right]! ? -1 : names[left]! > names[right]! ? 1 : 0));
  const rank = new Uint32Array(names.length);
  for (let position = 0; position < order.length; position += 1) rank[order[position]!] = position;
  return rank;
}

export class ViewIndex {
  private readonly data: ViewIndexData;
  private tombstones = new Set<number>();
  private cache = new Map<string, number[]>();
  private memberCache = new Map<string, Set<number>>();

  constructor(data: ViewIndexData, tombstones?: Iterable<number>) {
    this.data = data;
    if (tombstones) for (const id of tombstones) this.tombstones.add(id);
  }

  tombstone(ids: Iterable<number>) {
    for (const id of ids) this.tombstones.add(id);
    this.cache.clear();
    this.memberCache.clear();
  }

  page(query: ViewQuery, offset: number, limit: number): { ids: number[]; total: number } {
    const list = this.materialize(query);
    return { ids: list.slice(offset, offset + limit), total: list.length };
  }

  total(query: ViewQuery) {
    return this.materialize(query).length;
  }

  /** Every folder with its own (non-subtree) record count — the sidebar tree
   * derives subtree totals itself. Counts reflect the last rebuild. */
  folders(): FolderCount[] {
    const { folderCounts, folderNames } = this.data;
    const list: FolderCount[] = [];
    for (let id = 0; id < folderNames.length; id += 1) {
      list.push({ folder: folderNames[id]!, count: folderCounts[id]! });
    }
    return list;
  }

  /** How many live records point at this host. */
  hostCount(host: string) {
    const hostId = this.data.hostNames.indexOf(host);
    if (hostId === -1) return 0;
    let count = 0;
    const { hostIdOf, ids } = this.data;
    for (let index = 0; index < hostIdOf.length; index += 1) {
      if (hostIdOf[index] === hostId && !this.tombstones.has(ids[index]!)) count += 1;
    }
    return count;
  }

  /** Live record ids inside `folder` (subtree included), as a Set — the
   * search scope predicate. Cached per folder because it is rebuilt on every
   * keystroke otherwise. */
  folderMemberSet(folder: string): Set<number> {
    const cached = this.memberCache.get(folder);
    if (cached) return cached;
    const members = new Set(this.materialize({ view: 'folder', folder, subtree: true, sort: 'oldest' }));
    if (this.memberCache.size >= VIEW_CACHE_LIMIT) this.memberCache.clear();
    this.memberCache.set(folder, members);
    return members;
  }

  /** Every host with its record count, largest first — the favicon builder's
   * priority order. Counts reflect the last rebuild. */
  hosts(): Array<{ host: string; count: number }> {
    const { hostCounts, hostNames } = this.data;
    const list: Array<{ host: string; count: number }> = [];
    for (let id = 0; id < hostNames.length; id += 1) {
      list.push({ host: hostNames[id]!, count: hostCounts[id]! });
    }
    list.sort((left, right) => right.count - left.count);
    return list;
  }

  /** The base hosts of the given records, plus every live id inside the
   * query's scope that shares one of those hosts — "select all on this site
   * in the current folder". Sort/offset on the query are ignored; order is
   * irrelevant to a selection. */
  hostExpansion(memberIds: number[], query: ViewQuery): { hosts: string[]; ids: number[] } {
    const { ids, hostIdOf, folderIdOf, hostNames, folderNames } = this.data;
    const hostIds = new Set<number>();
    for (const memberId of memberIds) {
      const position = this.positionOf(memberId);
      if (position !== -1) hostIds.add(hostIdOf[position]!);
    }
    if (hostIds.size === 0) return { hosts: [], ids: [] };

    let wanted: Set<number> | null = null;
    if (query.view === 'folder') {
      wanted = new Set<number>();
      const prefix = query.folder + FOLDER_SEPARATOR;
      for (let id = 0; id < folderNames.length; id += 1) {
        const name = folderNames[id]!;
        if (name === query.folder || (query.subtree && name.startsWith(prefix))) wanted.add(id);
      }
    }

    const expanded: number[] = [];
    for (let position = 0; position < ids.length; position += 1) {
      if (!hostIds.has(hostIdOf[position]!)) continue;
      if (wanted && !wanted.has(folderIdOf[position]!)) continue;
      const id = ids[position]!;
      if (this.tombstones.has(id)) continue;
      expanded.push(id);
    }
    const hosts = Array.from(hostIds, (hostId) => hostNames[hostId]!).sort();
    return { hosts, ids: expanded };
  }

  /** Position of a record id in the ascending id column, or -1. */
  private positionOf(recordId: number) {
    const { ids } = this.data;
    let low = 0;
    let high = ids.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const value = ids[mid]!;
      if (value === recordId) return mid;
      if (value < recordId) low = mid + 1;
      else high = mid - 1;
    }
    return -1;
  }

  /** All live record ids on the given host, newest first. */
  idsForHost(host: string): number[] {
    const hostId = this.data.hostNames.indexOf(host);
    if (hostId === -1) return [];
    const { byDate, hostIdOf, ids } = this.data;
    const list: number[] = [];
    for (let step = byDate.length - 1; step >= 0; step -= 1) {
      const position = byDate[step]!;
      if (hostIdOf[position] !== hostId) continue;
      const id = ids[position]!;
      if (!this.tombstones.has(id)) list.push(id);
    }
    return list;
  }

  private materialize(query: ViewQuery): number[] {
    const key = `${query.view}\u0000${query.sort}\u0000${query.subtree ? 's' : 'e'}\u0000${query.folder}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const { ids, folderIdOf, byDate, byTitle, byHost, folderNames } = this.data;
    let matches: ((folderId: number) => boolean) | null = null;
    if (query.view === 'folder') {
      const wanted = new Set<number>();
      const prefix = query.folder + FOLDER_SEPARATOR;
      for (let id = 0; id < folderNames.length; id += 1) {
        const name = folderNames[id]!;
        if (name === query.folder || (query.subtree && name.startsWith(prefix))) wanted.add(id);
      }
      matches = (folderId) => wanted.has(folderId);
    }

    const permutation = query.sort === 'title' ? byTitle : query.sort === 'site' ? byHost : byDate;
    const reversed = query.sort === 'newest';
    const list: number[] = [];
    for (let step = 0; step < permutation.length; step += 1) {
      const position = permutation[reversed ? permutation.length - 1 - step : step]!;
      if (matches && !matches(folderIdOf[position]!)) continue;
      const id = ids[position]!;
      if (this.tombstones.has(id)) continue;
      list.push(id);
    }

    if (this.cache.size >= VIEW_CACHE_LIMIT) this.cache.clear();
    this.cache.set(key, list);
    return list;
  }
}
