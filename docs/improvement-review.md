# Corral and Bookmark OS review — September 4, 2026

The workspace contains two distinct products. Corral is the stronger foundation for a large, private bookmark library: IndexedDB persistence, worker-based substring search, virtualized rows, and incremental folder/deletion updates. The local Bookmark OS extension is useful for people who want to organize the live Chrome tree. Preserve that distinction in the product and installation instructions.

The public [Bookmark OS product](https://bookmarkos.com/) offers broader productivity features including notes, tasks, tags, and saved tab sessions. It is a separate product from the local extension in this repository. This pass focuses on correctness and complete bookmark workflows in the local apps.

## Improvements implemented

| Area | Corral | Local Bookmark OS |
| --- | --- | --- |
| Everyday use | Manual add/edit, visible row edit action, F2, edit Undo, folder breadcrumbs, accurate folder count | Add links, safe URL validation, refreshed metadata after edits |
| Recovery | Folder Undo restores the actual tree, including empty descendants; name collisions are rejected; deletion above the existing 50,000-record Undo limit requires explicit confirmation | Bulk move/delete count successful API calls only; failures stay selected; Undo restores successful changes and supports retrying failures |
| Portability | HTML exports contain genuine nested folders once per folder, including across chunk boundaries; HTML/JSON retain empty folders; JSON preserves import timestamps and rejects unsupported shapes | HTML backup preserves hierarchy, dates and empty folders |
| Search/selection | Active search refreshes after mutations; obsolete async select-all/range results are discarded; query changes clear stale selections; context menu facts stay tied to the right bookmark | Search includes folder paths; filter/sort changes reset the range anchor and scroll position; empty results survive resize/scroll |
| Accessibility/layout | Stable modal/menu focus, explicit search label, bounded popovers, visible mobile row controls and collapsible sidebar | Focus-trapped dialogs, labelled fields and actions, keyboard folder picker, better contrast, reduced motion, responsive controls |
| Privacy/security | Manual add/edit rejects script/data URLs; clipboard success reported only when copying succeeds | Local fonts and Chrome favicon endpoint replace external requests; unsafe navigation blocked; unused broad permissions removed; inline error handlers removed |
| Scale/maintenance | Folder rename Undo no longer transfers one prior-folder record per bookmark; opening a large selection loads only the 15 records actually opened | Folder totals computed in one traversal; bounded API concurrency; set-based bulk membership; bounded duplicate panel; Chrome events coalesced; source included in version control |

## Verification

`npm run build` runs the engine, parser, data-operation, manifest, actual-worker, and Bookmark OS suites, then TypeScript checking and a production Vite build. `npm run lint` checks the JavaScript and TypeScript sources.

The new worker suite exercises add/edit validation and metadata retention, updated host membership and search results, empty and occupied folder Undo, collision rejection, empty-folder import/export, invalid JSON, and a 5,100-link single-folder HTML export that spans batches. Bookmark OS tests cover tree aggregates, exact-URL duplicate keepers, escaping and hierarchy, URL safety, and bounded concurrency with rejected API calls.

Browser checks covered Corral add → edit → Undo, editing inside active search, and folder navigation at 390 × 844. Bookmark OS was exercised against the disposable browser fixture: 77 deletion attempts produced 76 successful removals and one retained protected item, and Undo restored all 76. Production Chrome bookmark mutations and extension installation were not performed.

The existing 500,000-record synthetic benchmark measured search p50 **24.904 ms**, p95 **40.454 ms**, view ordering build **0.38 s**, and heap use **73.5 MB** on this machine. These are in-memory engine measurements, not full browser import or rendering timings, and are not a before/after comparison.

## Remaining priorities

1. Persist recovery history in both apps. Current Undo is transient; Corral's toast lasts eight seconds, and Bookmark OS history lasts for the current manager session. A dedicated history/trash interface would make recovery more discoverable.
2. Make manual Corral add/edit update title/host ordering incrementally. These edits currently rebuild the worker index; folder moves and deletions retain their incremental path. Bound the UI page cache for long scrolling sessions.
3. Add quota/interrupted-write and multi-tab fault-injection tests, plus automated browser regression coverage against the real extension runtime. The mock fixture cannot establish Chrome-specific permission behavior or favicon retrieval.
4. Preserve truly empty Chrome folders during Corral's direct Chrome copy, and add a preview of import/duplicate conflicts before applying them.
5. Add opt-in tags, pinned folders, and saved tab sessions after the data model and backup format are designed together. Keep cloud sync, website crawling, and third-party metadata fetching explicit choices.

The known gaps above remain open; this review does not claim complete parity with a hosted productivity suite or exhaustive coverage of every browser failure mode.
