// Pure data helpers shared by the extension and its regression suite.
export function openableUrl(raw) {
  try {
    const value = raw.trim();
    return ['http:', 'https:', 'chrome:', 'file:', 'ftp:', 'mailto:', 'tel:'].includes(new URL(value).protocol) ? value : null;
  } catch { return null; }
}

export function indexTree(tree) {
  const bookmarks = [];
  const folders = Object.create(null);
  const domainMap = Object.create(null);
  const rootIds = [];
  const stack = tree.slice().reverse().map(node => ({ node, path: '' }));
  const order = [];
  while (stack.length) {
    const { node, path } = stack.pop();
    if (node.url) {
      let domain = '';
      try { domain = new URL(node.url).hostname.replace(/^www\./, ''); } catch { /* Keep unsupported saved URLs visible. */ }
      bookmarks.push({ id: node.id, title: node.title || node.url, url: node.url, dateAdded: node.dateAdded || 0, parentId: node.parentId, index: node.index, path, domain });
      if (domain) domainMap[domain] = (domainMap[domain] || 0) + 1;
    } else {
      const title = node.title || (node.id === '0' ? 'Root' : 'Unnamed Folder');
      const nextPath = node.id === '0' ? path : (path ? `${path} › ${title}` : title);
      folders[node.id] = { id: node.id, title, parentId: node.parentId, childIds: (node.children || []).filter(child => !child.url).map(child => child.id), count: 0, total: 0, path: nextPath };
      order.push(node.id);
      if (node.parentId === '0') rootIds.push(node.id);
      for (const child of (node.children || []).slice().reverse()) stack.push({ node: child, path: nextPath });
    }
  }
  for (const bm of bookmarks) if (folders[bm.parentId]) folders[bm.parentId].count++;
  for (const id of order.reverse()) {
    const folder = folders[id];
    folder.total += folder.count;
    if (folders[folder.parentId]) folders[folder.parentId].total += folder.total;
  }
  return { bookmarks, folders, rootIds, domainMap };
}

/** Keep the oldest exact URL. Never equate distinct paths or fragments. */
export function duplicateIds(bookmarks) {
  const keepers = new Map();
  const extras = [];
  for (const bm of bookmarks) {
    const best = keepers.get(bm.url);
    if (!best) keepers.set(bm.url, bm);
    else if (bm.dateAdded < best.dateAdded) { extras.push(best.id); keepers.set(bm.url, bm); }
    else extras.push(bm.id);
  }
  return extras;
}

/** Bounded Chrome API concurrency; only successful operations count. */
export async function runBatch(items, action, progress = () => {}) {
  const succeeded = [];
  const failed = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      try { await action(item); succeeded.push(item); }
      catch (error) { failed.push({ item, message: error instanceof Error ? error.message : String(error) }); }
      progress(succeeded.length + failed.length, items.length);
    }
  }));
  return { succeeded, failed };
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function exportTreeHtml(tree) {
  const parts = ['<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>BookmarkOS backup</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n'];
  const stack = tree.slice().reverse();
  while (stack.length) {
    const node = stack.pop();
    if (node === null) { parts.push('</DL><p>\n'); continue; }
    if (node.url) parts.push(`<DT><A HREF="${escapeHtml(node.url)}" ADD_DATE="${Math.floor((node.dateAdded || 0) / 1000)}">${escapeHtml(node.title || node.url)}</A>\n`);
    else {
      if (node.id !== '0') parts.push(`<DT><H3>${escapeHtml(node.title)}</H3>\n<DL><p>\n`);
      if (node.id !== '0') stack.push(null);
      const children = node.children || [];
      for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
    }
  }
  parts.push('</DL><p>\n');
  return parts;
}
