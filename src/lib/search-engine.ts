// Sift's search engine: a sharded, flat-haystack substring scanner.
//
// Instead of an inverted index that must be built, serialized, and restored
// (the source of the post-import hangs this replaces), each shard holds the
// records' searchable text as one concatenated lowercase string. A query is
// answered by running `String.indexOf` over every shard — V8's SIMD-backed
// scan covers ~50 MB in well under 50 ms, which is plenty for type-ahead at
// 500k records. The "index" is finished the moment the text is concatenated,
// persists as a handful of large rows, and supports true substring matches
// (searching "flix" finds "netflix"), not just token prefixes.
//
// This module is dependency-free so the worker, the UI, and the Node
// benchmark can all share it.

// Field separator inside a record's text and record separator between
// records. Both are stripped from field values and from queries, so a term
// can never straddle a field or record boundary.
const FIELD_SEP = '\u001f';
const RECORD_SEP = '\n';

const SHARD_MAX_RECORDS = 16_384;
const SHARD_MAX_CHARS = 2_000_000;

// Score weights per field. A term hit in the title far outranks one buried in
// the URL's query string.
const SCORE_TITLE_PREFIX = 8;
const SCORE_TITLE = 4;
const SCORE_HOST = 3;
const SCORE_FOLDER = 2;
const SCORE_URL = 1;
const MAX_SCORE_BUCKETS = 64;

// Very short terms match almost everything; processing millions of hits per
// keystroke wastes time on results nobody scrolls. Cap the accepted matches
// per shard for those queries and mark the result truncated.
const SHORT_TERM_LENGTH = 2;
const SHORT_TERM_SHARD_CAP = 768;

export type SearchableRecord = {
  id: number;
  title: string;
  url: string;
  host: string;
  folder: string;
};

export type ShardData = {
  ids: Uint32Array;
  /** starts[i] = offset of record i's text; starts[ids.length] = text.length. */
  starts: Uint32Array;
  text: string;
};

export type SearchResult = {
  ids: number[];
  total: number;
  truncated: boolean;
};

// Deliberately matches control characters - they are the shard separators.
// oxlint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f]+/g;

function cleanField(value: string) {
  return value.replace(CONTROL_CHARS, ' ');
}

export function recordText(record: SearchableRecord) {
  return `${cleanField(record.title)}${FIELD_SEP}${cleanField(record.url)}${FIELD_SEP}${cleanField(record.host)}${FIELD_SEP}${cleanField(record.folder)}`.toLowerCase();
}

export function parseQuery(query: string) {
  // Dedupe before capping, so repeated words never crowd out distinct terms.
  const terms = new Set(query.toLowerCase().replace(CONTROL_CHARS, ' ').split(' ').filter(Boolean));
  return Array.from(terms).slice(0, 6);
}

/** Accumulates records into finished shards during a rebuild scan. */
export class ShardBuilder {
  private shards: ShardData[] = [];
  private ids: number[] = [];
  private starts: number[] = [];
  private parts: string[] = [];
  private chars = 0;

  add(record: SearchableRecord) {
    const text = recordText(record);
    this.ids.push(record.id);
    this.starts.push(this.chars);
    this.parts.push(text);
    this.chars += text.length + RECORD_SEP.length;
    if (this.ids.length >= SHARD_MAX_RECORDS || this.chars >= SHARD_MAX_CHARS) this.flush();
  }

  private flush() {
    if (this.ids.length === 0) return;
    this.starts.push(this.chars);
    this.shards.push({
      ids: Uint32Array.from(this.ids),
      starts: Uint32Array.from(this.starts),
      text: this.parts.join(RECORD_SEP) + RECORD_SEP,
    });
    this.ids = [];
    this.starts = [];
    this.parts = [];
    this.chars = 0;
  }

  finish() {
    this.flush();
    const built = this.shards;
    this.shards = [];
    return built;
  }
}

export class ShardStore {
  private shards: ShardData[] = [];
  private tombstones = new Set<number>();

  static fromShards(shards: ShardData[], tombstones?: Iterable<number>) {
    const store = new ShardStore();
    store.shards = shards;
    if (tombstones) store.tombstone(tombstones);
    return store;
  }

  get tombstoneCount() {
    return this.tombstones.size;
  }

  get tombstoneIds() {
    return Uint32Array.from(this.tombstones);
  }

  tombstone(ids: Iterable<number>) {
    for (const id of ids) this.tombstones.add(id);
  }

  /** `accept` scopes the search (e.g. to one folder's ids). It runs inside the
   * match loop, so a scoped query ranks and counts only in-scope records —
   * filtering the top-N afterwards would starve small scopes on common terms. */
  search(query: string, limit: number, accept?: (id: number) => boolean): SearchResult {
    const terms = parseQuery(query);
    if (terms.length === 0) return { ids: [], total: 0, truncated: false };

    // Scan for the longest term (the best rarity proxy) and verify the rest
    // only inside candidate records. Verification always works on the bounded
    // record slice — a raw indexOf from the record start would scan to the end
    // of the shard whenever a term is absent.
    const scanTerm = terms.reduce((longest, term) => (term.length > longest.length ? term : longest));
    const rest = terms.filter((term) => term !== scanTerm);
    const shortQuery = scanTerm.length <= SHORT_TERM_LENGTH;
    // Queries that match a large share of the library get cut off: ranking has
    // no meaning there, and processing hundreds of thousands of hits per
    // keystroke buys nothing anyone scrolls to.
    const maxTotal = Math.max(limit * 4, 20_000);

    const buckets: number[][] = [];
    let total = 0;
    let truncated = false;

    // Newest shards first, so a truncated result favors recent bookmarks.
    outer: for (let shardIndex = this.shards.length - 1; shardIndex >= 0; shardIndex -= 1) {
      const { ids, starts, text } = this.shards[shardIndex]!;
      const acceptedScores: number[] = [];
      const acceptedIds: number[] = [];
      let recordIndex = 0;
      let position = text.indexOf(scanTerm);
      while (position !== -1) {
        while (starts[recordIndex + 1]! <= position) recordIndex += 1;
        const start = starts[recordIndex]!;
        const end = starts[recordIndex + 1]! - RECORD_SEP.length;
        const id = ids[recordIndex]!;

        if (!this.tombstones.has(id) && (!accept || accept(id))) {
          const record = text.slice(start, end);
          let matchesAll = true;
          for (const term of rest) {
            if (!record.includes(term)) {
              matchesAll = false;
              break;
            }
          }
          if (matchesAll) {
            total += 1;
            acceptedScores.push(scoreRecord(record, position - start, scanTerm.length, rest));
            acceptedIds.push(id);
            if (total >= maxTotal || (shortQuery && acceptedIds.length >= SHORT_TERM_SHARD_CAP)) {
              truncated = true;
              flushShard(buckets, acceptedScores, acceptedIds);
              if (total >= maxTotal) break outer;
              continue outer;
            }
          }
        }
        // Skip the rest of this record; one evaluation per record.
        position = text.indexOf(scanTerm, starts[recordIndex + 1]!);
      }
      flushShard(buckets, acceptedScores, acceptedIds);
    }

    const ids: number[] = [];
    for (let score = buckets.length - 1; score >= 0 && ids.length < limit; score -= 1) {
      const bucket = buckets[score];
      if (!bucket) continue;
      for (let index = 0; index < bucket.length && ids.length < limit; index += 1) {
        ids.push(bucket[index]!);
      }
    }
    return { ids, total, truncated: truncated || total > ids.length };
  }
}

/** Appends a shard's accepted hits to the score buckets newest-first, so each
 * score tier stays globally ordered from newest shard to oldest. */
function flushShard(buckets: number[][], scores: number[], ids: number[]) {
  for (let index = ids.length - 1; index >= 0; index -= 1) {
    (buckets[scores[index]!] ??= []).push(ids[index]!);
  }
  scores.length = 0;
  ids.length = 0;
}

/** Scores one record slice. `scanHit` is the offset of the scan term's first
 * occurrence within the slice. */
function scoreRecord(record: string, scanHit: number, scanTermLength: number, rest: string[]) {
  const titleEnd = record.indexOf(FIELD_SEP);
  const urlEnd = record.indexOf(FIELD_SEP, titleEnd + 1);
  const hostEnd = record.indexOf(FIELD_SEP, urlEnd + 1);
  const fieldScore = (hit: number) => {
    if (hit < titleEnd) return hit === 0 ? SCORE_TITLE_PREFIX : SCORE_TITLE;
    if (hit < urlEnd) return SCORE_URL;
    if (hit < hostEnd) return SCORE_HOST;
    return SCORE_FOLDER;
  };
  let score = fieldScore(scanHit) + (scanTermLength >= 3 ? 1 : 0);
  for (const term of rest) {
    const hit = record.indexOf(term);
    if (hit !== -1) score += fieldScore(hit);
  }
  return Math.min(score, MAX_SCORE_BUCKETS - 1);
}
