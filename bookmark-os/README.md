# Bookmark OS (local Chrome extension)

This folder contains the standalone BookmarkOS extension. It edits **Chrome's actual bookmark tree**. Corral, in the parent project, keeps its own local IndexedDB library instead. This extension is separate from the hosted product at bookmarkos.com.

Load this folder directly through Chrome → Extensions → Developer mode → Load unpacked. Click the extension toolbar icon to open the manager directly. Existing manager tabs are reused and their windows focused. Reload the extension after updating its files or manifest.

The navy-and-gold bookmark icon is supplied in 16, 32, 48, and 128px sizes for the toolbar, extension listing, and browser tab. Regenerate the PNGs from the parent project with `node scripts/make-icons.mjs --bookmark-os`; `icons/icon.svg` provides an editable vector counterpart.

- Add and edit links, browse folders, search titles/URLs/folder paths, filter by domain, and sort.
- Select a range with Shift; use Ctrl/Cmd+A for all current results, `/` or Ctrl/Cmd+F for search, Enter to open a focused row, Space to select, and F2 to edit.
- Move or delete selected bookmarks with progress and accurate success/failure counts. Failed items remain visible and selected.
- **Undo** restores the last successful move, deletion, or auto-organize move while the manager stays open. A later successful bulk operation replaces this history. Undo of a deletion creates new Chrome bookmark IDs and creation dates; Chrome does not let this API restore those original values. Failed Undo entries remain available for retry. Auto-organize Undo restores bookmark locations; it leaves newly created domain folders empty.
- **Backup** downloads a browser-compatible HTML file with nested and empty folders. Chrome can import this through its bookmark manager.
- Duplicate cleanup keeps the oldest bookmark for each **exact URL**; distinct paths, queries, and fragments are not merged.
- Auto-organize reuses matching destination folders instead of creating another folder on each run.
- Icons use Chrome's favicon endpoint. No external font CDN or Google favicon request is used. Only `bookmarks` and `favicon` permissions are required.

Run `npm test` from the parent folder for the shared regression suite. For a browser test without touching Chrome data, run `npm run dev` and open `/scripts/fixtures/bookmark-os-preview.html`. Its in-memory Chrome API fixture contains 77 bookmarks, including one protected item that rejects mutations. Refreshing that fixture resets its data.
