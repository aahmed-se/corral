import { normalizeUrl, type BookmarkRecord } from './db.ts';
import type { RawBookmarkInput } from './import-export.ts';

/** Imports merge by the same normalized URL used by duplicate detection.
 * Folder, title, source, and other mutable fields are deliberately excluded:
 * a repeat import must never undo the user's current local organization. */
export function importKey(value: RawBookmarkInput | BookmarkRecord) {
  return 'normalizedUrl' in value ? value.normalizedUrl : normalizeUrl(value.url);
}

export function countImportKeys(inputs: RawBookmarkInput[]) {
  const counts = new Map<string, number>();
  for (const input of inputs) {
    const key = importKey(input);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Preserves multiplicity: if an import contains the same URL three times and
 * the library contains two copies, exactly one new copy is inserted. */
export function selectUnmatchedInputs(inputs: RawBookmarkInput[], matchedExisting: ReadonlyMap<string, number>) {
  const remaining = new Map(matchedExisting);
  const additions: RawBookmarkInput[] = [];
  let skipped = 0;
  for (const input of inputs) {
    const key = importKey(input);
    const matches = remaining.get(key) ?? 0;
    if (matches > 0) {
      skipped += 1;
      if (matches === 1) remaining.delete(key);
      else remaining.set(key, matches - 1);
    } else {
      additions.push(input);
    }
  }
  return { additions, skipped };
}
