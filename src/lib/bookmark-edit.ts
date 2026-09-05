import { db, makeRecord, markLibraryDirty, type BookmarkRecord } from './db.ts';
import { openableBookmarkUrl } from './bookmark-url.ts';

export type BookmarkDraft = { title: string; url: string; folder: string };

/** Save editable fields atomically; retain identity and import metadata. */
export async function saveBookmark(draft: BookmarkDraft, id?: number) {
  const url = openableBookmarkUrl(draft.url);
  if (!url) throw new Error('Enter a complete URL, such as https://example.com. Script and data URLs cannot be saved.');
  return db.transaction('rw', db.bookmarks, db.meta, async () => {
    const previous = id === undefined ? undefined : await db.bookmarks.get(id);
    if (id !== undefined && !previous) throw new Error('This bookmark no longer exists.');
    const normalized = makeRecord({ ...draft, url, dateAdded: previous?.dateAdded ?? Date.now(), source: previous?.source ?? 'manual' });
    const record: BookmarkRecord = previous
      ? { ...previous, title: normalized.title, url, folder: normalized.folder, host: normalized.host, normalizedUrl: normalized.normalizedUrl }
      : normalized;
    await markLibraryDirty();
    record.id = await db.bookmarks.put(record);
    return { record, previous };
  });
}
