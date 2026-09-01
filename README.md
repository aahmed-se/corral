# Corral

Round up your bookmarks. Corral is a local-first bookmark organizer built for libraries up to 500,000 links — a folder-first workspace with instant search, drag-and-drop that works on any selection size, and one-gesture domain roundups. Everything lives in IndexedDB on your device: no account, server, sync, or analytics.

## What it does

- **File-explorer folder views**: the tree on the left has live subtree counts; opening a folder shows its direct bookmarks and immediate child folders instead of flattening every descendant URL.
- **Folder editing in place**: create folders (empty ones included), rename or re-parent a whole subtree from the right-click menu, drag one folder onto another to nest it, and remove empty folders. Renames rewrite every descendant path and offer Undo.
- **Non-destructive imports** from Chrome (Chrome's tree is never modified), Chrome/Firefox/Netscape HTML exports, or Corral JSON backups. Re-importing keeps the current Corral rows and folder organization intact, skips normalized URLs already present, and adds only new entries. Export both file formats back out.
- **Lightning search, scoped to where you are**: true substring matching across titles, URLs, hosts, and folders, ~10 ms across 100k bookmarks, ranked by match field. Select a folder and the same query narrows to that subtree — scoping happens inside the scan, so a small folder is never drowned out by a common term.
- **Duplicate cleanup**: one toolbar button scans the library by normalized URL (tracking parameters, fragments, and case ignored), keeps the oldest copy of each link, and removes the rest — with a confirm step and Undo.
- **Site icon cache**: fetch favicons for every bookmarked host (most-bookmarked first) into IndexedDB — via Chrome's own favicon store when running as the extension, or a hostname-only dev-server relay in the preview. Chrome retrieval tries real saved URLs locally before origin/scheme fallbacks; image bytes are validated, and requested refreshes immediately retry missing/error entries. Resumable, stoppable, and rendered per row with a letter-mark fallback. Page titles/descriptions are deliberately not crawled — fetching 100k pages is not a background feature.
- **Three row densities** — roomy, cozy, compact — switchable from the toolbar.
- **Drag and drop at scale**: drag one row or a 50,000-row selection onto any folder in the tree (drop on "All bookmarks" to unfile). Spring-loaded folders expand while you hover, edges auto-scroll, Esc cancels, and every move offers Undo. Moves, renames, and deletes patch the live index in place — nothing is rescanned, so the list and folder counts update the moment the drop lands.
- **Site actions from the right-click menu**: "Show all from site.com" searches the host, "Select all N from site.com" selects every match in the current folder or result list (then drag, move, or delete them), and "Corral all N on site.com…" rounds up the whole library's bookmarks on that host into one folder, with Undo. Hovering a row also reveals open and remove buttons.
- Multi-select with click, Cmd/Ctrl-click, Shift-ranges, Cmd/Ctrl-A for every bookmark in the current result list, Escape to clear, and one-click expansion to matching base URLs directly in the current folder.

## Architecture

The UI thread only renders; a worker owns all data work:

- `src/lib/search-engine.ts` — sharded flat-haystack substring scanner. No inverted index to build or restore; the "index" is the concatenated text, scanned with `String.indexOf`. Records whose text changes (a move rewrites the folder field) are re-indexed into small *delta shards* that supersede their base entries, so a mutation never rewrites the big shards.
- `src/lib/view-index.ts` — in-memory row ordering and aggregates: one sort permutation per sort mode plus compact filter/count arrays. A page at any scroll depth is an id slice + primary-key `bulkGet`; folder counts and per-host membership come from the same arrays. Moves, folder renames, deletes, and undo patch these arrays in place. Nothing on disk scales with unique-host count.
- `src/lib/worker.ts` — one streamed pass builds search shards + view ordering with per-phase progress. Mutations run as serialized ops that patch the served index immediately and then save just the patch (delta shard rows, the view arrays, tombstones, and a stats row whose dirty token vouches for the op); only imports rescan. When tombstones or delta shards pile up, a compaction rebuild runs quietly behind the current index. Imports, exports, and parsing (a DOMParser-free tokenizer) all execute here.
- `src/lib/db.ts` — Dexie store with one bookmark secondary index (`folder`); IndexedDB serves primary-key lookups, never deep offset cursors.

## Develop

```
npm install
npm run dev        # local preview at :3100 (Chrome copy requires the extension)
npm test           # engine, parser, and op suites (Node 22.18+)
npm run benchmark  # 500k-record engine benchmark
npm run build      # dist/ = loadable unpacked Chrome extension
```

## Install in Chrome

1. `npm run build`
2. Open `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → select the `dist/` folder.
4. Click the Corral toolbar button (or Ctrl/⌘-Shift-O). Repeated clicks focus the existing Corral tab.
