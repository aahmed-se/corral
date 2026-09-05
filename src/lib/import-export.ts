import type { BookmarkRecord, BookmarkSource } from './db.ts';

/** Parsed-but-not-normalized bookmark input. URL normalization (makeRecord)
 * is deliberately deferred to the worker — it is the expensive part. */
export type RawBookmarkInput = {
  chromeId?: string;
  importedAt?: number;
  title: string;
  url: string;
  folder: string;
  dateAdded: number;
  source: BookmarkSource;
};

export function chromeBookmarksAvailable() {
  return typeof chrome !== 'undefined' && Boolean(chrome.bookmarks?.getTree);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}

// The entities that actually occur in bookmark exports: the XML five plus the
// Latin-1/punctuation names older tools emitted. Anything else stays literal.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  mdash: '—', ndash: '–', hellip: '…', middot: '·', bull: '•', deg: '°',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  copy: '©', reg: '®', trade: '™', sect: '§', para: '¶', laquo: '«', raquo: '»',
  agrave: 'à', aacute: 'á', acirc: 'â', auml: 'ä', aring: 'å', aelig: 'æ',
  ccedil: 'ç', egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë',
  igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï', ntilde: 'ñ',
  ograve: 'ò', oacute: 'ó', ocirc: 'ô', ouml: 'ö', oslash: 'ø',
  ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', yacute: 'ý',
  szlig: 'ß', euro: '€', pound: '£', yen: '¥',
};

function decodeEntities(value: string) {
  if (!value.includes('&')) return value;
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      // Out-of-range code points would make fromCodePoint throw and abort the
      // whole import over one corrupt entity; leave them literal instead.
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export const NETSCAPE_HEADER = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Corral Bookmarks</TITLE>\n<H1>Corral Bookmarks</H1>\n<DL><p>\n';
export const NETSCAPE_CLOSE = '</DL><p>\n';
export const htmlFolderOpen = (name: string) => `<DT><H3>${escapeHtml(name)}</H3>\n<DL><p>\n`;
export const htmlBookmark = (item: BookmarkRecord) => `<DT><A HREF="${escapeHtml(item.url)}" ADD_DATE="${Math.floor(item.dateAdded / 1000)}">${escapeHtml(item.title)}</A>\n`;

/** Iterative traversal preserves real nested folders, including empty ones. */
export function* folderExportSteps(paths: string[]): Generator<{ kind: 'open'; name: string; path: string } | { kind: 'close' }> {
  const all = new Set<string>();
  for (const path of paths) {
    const segments = path.split(' / ');
    for (let depth = 1; depth <= segments.length; depth++) all.add(segments.slice(0, depth).join(' / '));
  }
  const children = new Map<string, string[]>();
  for (const path of all) {
    const cut = path.lastIndexOf(' / ');
    const parent = cut < 0 ? '' : path.slice(0, cut);
    const list = children.get(parent) ?? [];
    list.push(path);
    children.set(parent, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.localeCompare(b));
  const stack: Array<string | null> = (children.get('') ?? []).slice().reverse();
  while (stack.length) {
    const path = stack.pop();
    if (path === null) { yield { kind: 'close' }; continue; }
    if (path === undefined) continue;
    yield { kind: 'open', path, name: path.split(' / ').at(-1)! };
    stack.push(null);
    const descendants = children.get(path) ?? [];
    for (let index = descendants.length - 1; index >= 0; index--) stack.push(descendants[index]!);
  }
}

export function toNetscapeHtmlParts(records: BookmarkRecord[], emptyFolders: string[] = []) {
  const byFolder = new Map<string, BookmarkRecord[]>();
  for (const record of records) {
    const group = byFolder.get(record.folder) ?? [];
    group.push(record);
    byFolder.set(record.folder, group);
  }
  const parts = [NETSCAPE_HEADER];
  for (const step of folderExportSteps([...byFolder.keys(), ...emptyFolders])) {
    if (step.kind === 'close') parts.push(NETSCAPE_CLOSE);
    else {
      parts.push(htmlFolderOpen(step.name));
      parts.push((byFolder.get(step.path) ?? []).map(htmlBookmark).join(''));
    }
  }
  parts.push(NETSCAPE_CLOSE);
  return parts;
}

const TAG_PATTERN = /<(\/?)(a|h3|dl)(?=[\s>/])([^>]*)>/gi;
// Inner content ends at the row's own close tag OR at the next structural tag
// — whichever comes first. Old Netscape rows omit close tags, and treating a
// LATER row's close tag as ours would swallow every record in between.
const A_BOUNDARY = /<\/a\s*>|<(?:dt|h3|dl)[\s>/]|<a[\s>/]/i;
const H3_BOUNDARY = /<\/h3\s*>|<(?:dt|a|dl)[\s>/]|<h3[\s>/]/i;
const MAX_INNER_TEXT = 4_000;

const ATTRIBUTE_PATTERN = /([a-zA-Z_][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;

/** Tokenizes a tag's attributes left to right, so an attribute name occurring
 * inside another attribute's VALUE (e.g. add_date inside a URL) never
 * matches. */
function readAttributes(attrs: string) {
  const map = new Map<string, string>();
  ATTRIBUTE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTRIBUTE_PATTERN.exec(attrs)) !== null) {
    const name = match[1]!.toLowerCase();
    if (!map.has(name)) map.set(name, match[3] ?? match[4] ?? match[5] ?? '');
  }
  return map;
}

/** Parses Chrome/Firefox/Netscape bookmark exports with a plain string
 * tokenizer — DOMParser is unavailable in workers, and building a DOM for a
 * 100MB export froze the page anyway. Tracks the <H3>/<DL> folder structure
 * and tolerates the omitted closing tags these files traditionally have. */
export function parseNetscapeHtml(text: string, folderPaths?: string[]): RawBookmarkInput[] {
  const records: RawBookmarkInput[] = [];
  const folderStack: string[] = [];
  let pendingFolder: string | null = null;
  TAG_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_PATTERN.exec(text)) !== null) {
    const closing = match[1] === '/';
    const tag = match[2]!.toLowerCase();
    if (tag === 'dl') {
      if (closing) {
        if (folderStack.length > 0) folderStack.pop();
      } else {
        folderStack.push(pendingFolder ?? '');
        if (pendingFolder) folderPaths?.push(folderStack.filter(Boolean).join(' / '));
        pendingFolder = null;
      }
      continue;
    }
    if (closing) continue;
    const contentStart = TAG_PATTERN.lastIndex;
    // Search for the close tag only within a bounded window: an unbounded
    // scan would swallow every record up to some far-away close tag when a
    // row omits its own (as old Netscape files do), and rows with NO close
    // tag at all would turn the parse quadratic.
    const window = text.slice(contentStart, contentStart + MAX_INNER_TEXT);
    const boundary = (tag === 'a' ? A_BOUNDARY : H3_BOUNDARY).exec(window);
    const closed = boundary !== null && boundary[0].startsWith('</');
    const contentEnd = contentStart + (boundary ? boundary.index : window.length);
    const inner = decodeEntities(text.slice(contentStart, contentEnd).replace(/<[^>]*>/g, '')).trim();
    // Only consume our own close tag; a structural tag belongs to the next row.
    if (closed) TAG_PATTERN.lastIndex = contentEnd + boundary[0].length;

    if (tag === 'h3') {
      pendingFolder = inner || 'Folder';
      continue;
    }
    // <a>
    const attributes = readAttributes(match[3] ?? '');
    const href = attributes.get('href');
    if (!href) continue;
    const url = decodeEntities(href);
    const seconds = Number(attributes.get('add_date'));
    const folder = folderStack.filter(Boolean).join(' / ');
    records.push({
      title: inner || url,
      url,
      folder: folder || 'Imported',
      dateAdded: Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : Date.now(),
      source: 'html',
    });
  }
  return records;
}

export function parseBookmarkArchive(text: string): { records: RawBookmarkInput[]; folders: string[] } {
  const parsed = JSON.parse(text) as unknown;
  const candidate = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null && 'records' in parsed
      ? (parsed as { records: unknown }).records
      : typeof parsed === 'object' && parsed !== null && 'bookmarks' in parsed
        ? (parsed as { bookmarks: unknown }).bookmarks
        : null;
  if (!Array.isArray(candidate)) throw new Error('This JSON file does not contain a bookmark list.');
  const records: RawBookmarkInput[] = candidate.flatMap((value) => {
    if (typeof value !== 'object' || value === null || !('url' in value) || typeof value.url !== 'string') return [];
    const item = value as Partial<BookmarkRecord> & { url: string };
    return [{
      title: typeof item.title === 'string' ? item.title : item.url,
      url: item.url,
      folder: typeof item.folder === 'string' ? item.folder : 'Imported',
      dateAdded: typeof item.dateAdded === 'number' ? item.dateAdded : Date.now(),
      source: 'json' as const,
      importedAt: typeof item.importedAt === 'number' ? item.importedAt : undefined,
      chromeId: typeof item.chromeId === 'string' ? item.chromeId : undefined,
    }];
  });
  const folders = typeof parsed === 'object' && parsed !== null && 'folders' in parsed && Array.isArray(parsed.folders)
    ? parsed.folders.filter((path): path is string => typeof path === 'string' && Boolean(path.trim()))
    : [];
  return { records, folders };
}

export function parseBookmarkJson(text: string) {
  return parseBookmarkArchive(text).records;
}

/** Flattens an already-fetched Chrome tree into raw inputs. Cheap enough for
 * the main thread because it does no URL parsing — that happens in the
 * worker's import op. */
export function flattenChromeTree(nodes: chrome.bookmarks.BookmarkTreeNode[]): RawBookmarkInput[] {
  const inputs: RawBookmarkInput[] = [];
  const stack = nodes.slice().reverse().map((node) => ({ node, path: [] as string[] }));
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) break;
    const { node, path } = item;
    if (node.url) {
      inputs.push({
        chromeId: node.id,
        title: node.title || node.url,
        url: node.url,
        folder: path.join(' / ') || 'Chrome',
        dateAdded: node.dateAdded || Date.now(),
        source: 'chrome',
      });
      continue;
    }
    const nextPath = node.id === '0' || !node.title ? path : [...path, node.title];
    for (let index = (node.children?.length ?? 0) - 1; index >= 0; index -= 1) {
      stack.push({ node: node.children![index]!, path: nextPath });
    }
  }
  return inputs;
}
