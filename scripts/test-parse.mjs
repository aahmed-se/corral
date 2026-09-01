// Bookmark file parsing tests (DOMParser-free tokenizer).
// Usage: node scripts/test-parse.mjs

import { parseNetscapeHtml, parseBookmarkJson, toNetscapeHtmlParts, flattenChromeTree } from '../src/lib/import-export.ts';
import { makeRecord } from '../src/lib/db.ts';
import { countImportKeys, importKey, selectUnmatchedInputs } from '../src/lib/import-merge.ts';
import { openableBookmarkUrl } from '../src/lib/bookmark-url.ts';

const assert = (cond, label) => {
  if (!cond) {
    console.error('FAIL:', label);
    process.exit(1);
  }
};

const chromeExport = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1700000000" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="https://example.com/a?x=1&amp;y=2" ADD_DATE="1700000100">Tom &amp; Jerry &lt;classics&gt;</A>
        <DT><H3>Work</H3>
        <DL><p>
            <DT><A HREF="https://work.example/doc" ADD_DATE="1700000200">Quarterly doc</A>
        </DL><p>
        <DT><A HREF="https://example.org/after-nested" ADD_DATE="1700000300">After nested</A>
    </DL><p>
</DL><p>
`;

const parsed = parseNetscapeHtml(chromeExport);
assert(parsed.length === 3, `all anchors parsed, got ${parsed.length}`);
assert(parsed[0].title === 'Tom & Jerry <classics>' && parsed[0].url === 'https://example.com/a?x=1&y=2', 'entities decoded');
assert(parsed[1].folder === 'Bookmarks bar / Work', 'nested folder path');
assert(parsed[2].folder === 'Bookmarks bar', 'folder pops after nested DL');

// Rows without close tags must stay bounded and keep neighbors.
const noClose = parseNetscapeHtml('<DL><p>\n<DT><A HREF="https://one.example/a">Title one\n<DT><A HREF="https://two.example/b">Title two</A>\n</DL><p>');
assert(noClose.length === 2 && noClose[0].title === 'Title one', 'missing close tag bounded');

// Out-of-range entities stay literal; attribute names in values are ignored.
const hostile = parseNetscapeHtml('<DL><p><DT><A HREF="https://x.example/?add_date=99" ADD_DATE="1700000300">Bad &#x110000;</A></DL><p>');
assert(hostile[0].dateAdded === 1_700_000_300_000 && hostile[0].title.includes('&#x110000;'), 'hostile input tolerated');

// Round trip.
const records = [
  makeRecord({ title: 'Amp & "quote"', url: 'https://b.example/two?q=a&r=b', folder: 'Alpha / Beta', dateAdded: 1_700_000_060_000, source: 'json' }),
  makeRecord({ title: 'Plain', url: 'https://a.example/one', folder: 'Alpha', dateAdded: 1_700_000_000_000, source: 'json' }),
];
const back = parseNetscapeHtml(toNetscapeHtmlParts(records).join(''));
assert(back.length === 2, 'round trip count');
const byUrl = Object.fromEntries(back.map((r) => [r.url, r]));
for (const record of records) {
  const match = byUrl[record.url];
  assert(match && match.title === record.title && match.folder === record.folder, `round trip ${record.url}`);
}

// JSON import shape.
const json = parseBookmarkJson(JSON.stringify({ records: [{ title: 'J', url: 'https://j.example/x', folder: 'F', dateAdded: 5 }] }));
assert(json.length === 1 && json[0].folder === 'F', 'json import');
assert(openableBookmarkUrl('https://safe.example/path') !== null, 'https bookmark can open');
assert(openableBookmarkUrl('chrome://settings/') !== null, 'Chrome bookmark can open');
assert(openableBookmarkUrl('JaVaScRiPt:alert(document.domain)') === null, 'javascript bookmark is blocked');
assert(openableBookmarkUrl('data:text/html,<script>alert(1)</script>') === null, 'data bookmark is blocked');

// Repeat imports merge without changing current records. Matching is based on
// normalized URL, so local folder state and tracking-parameter differences do
// not create replacement rows. Duplicate multiplicity is still preserved.
const repeatInputs = [
  { title: 'One', url: 'https://Example.com/page/?utm_source=again#top', folder: 'Imported', dateAdded: 1, source: 'html' },
  { title: 'Second copy', url: 'https://example.com/page', folder: 'Elsewhere', dateAdded: 2, source: 'html' },
  { title: 'New', url: 'https://new.example/item', folder: 'Imported', dateAdded: 3, source: 'html' },
];
const wantedKeys = countImportKeys(repeatInputs);
assert(wantedKeys.get(importKey(repeatInputs[0])) === 2, 'import merge counts normalized URL copies');
const { additions, skipped } = selectUnmatchedInputs(repeatInputs, new Map([[importKey(repeatInputs[0]), 1]]));
assert(skipped === 1 && additions.length === 2, 'import merge skips only existing copies');
assert(additions.some((input) => input.url.includes('new.example')), 'import merge retains new URLs');

// Chrome tree flattening.
const tree = [{
  id: '0', title: '',
  children: [{
    id: '1', title: 'Bookmarks Bar',
    children: [
      { id: '2', title: 'Doc', url: 'https://doc.example/a', dateAdded: 1700000000000 },
      { id: '3', title: 'Deep', children: [{ id: '4', title: 'Nested', url: 'https://deep.example/b', dateAdded: 1700000001000 }] },
    ],
  }],
}];
const flat = flattenChromeTree(tree);
assert(flat.length === 2 && flat[0].folder === 'Bookmarks Bar' && flat[1].folder === 'Bookmarks Bar / Deep', 'chrome tree flatten');
assert(flat[1].chromeId === '4', 'chrome ids preserved');

// makeRecord hygiene.
const dirty = makeRecord({ title: 'Ti\u0000tle', url: 'https://d.example/x', folder: 'Work\u0000Stuff', dateAdded: 5, source: 'json' });
assert(dirty.folder === 'Work Stuff' && dirty.title === 'Ti tle', 'control characters sanitized');
assert(makeRecord({ title: 'X', url: 'HTTPS://Y.example/P/?utm_source=a', folder: '', dateAdded: 1, source: 'json' }).normalizedUrl === 'https://y.example/P', 'url normalization');

console.log('parse tests: ALL PASS');
