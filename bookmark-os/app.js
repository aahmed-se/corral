/* ================================================================
   BookmarkOS — app.js
   Virtual-scroll bookmark manager for 100,000+ bookmarks
   ================================================================ */

import { indexTree, duplicateIds, runBatch, openableUrl, exportTreeHtml } from './core.js';

let busy = false;
let undoAction = null;
let reloadTimer;
let priorFocus;
let loadingPromise;
let loadError = '';

// ── Constants ──────────────────────────────────────────────────
const ITEM_H  = 64;   // px height per bookmark row
const OVERSCAN = 12;  // extra items to render above/below viewport

// ── State ──────────────────────────────────────────────────────
let bookmarks  = [];   // full flat list of all bookmarks
let folders    = {};   // id → {id, title, parentId, childIds[], count}
let rootIds    = [];   // top-level folder ids (direct children of root "0")

let filtered   = [];   // current visible list after filters/sort
let selected   = new Set();
let dupUrls    = new Set();
let domainMap  = {};   // domain → count

// Filter/sort state
let curFolder  = 'all';
let searchQ    = '';
let sortKey    = 'dateAdded';
let sortAsc    = false;
let filterDomain = '';
let showDupsOnly = false;

// Virtual scroll state
let rafPending = false;
let lastClickIdx = null;

// ── DOM refs ────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const viewport    = $('list-viewport');
const sizer       = $('list-sizer');
const searchEl    = $('search-input');
const sortSel     = $('sort-select');
const domainSel   = $('domain-select');
const resultsEl   = $('results-count');
const bulkBar     = $('bulk-bar');
const selCountEl  = $('sel-count');
const folderTreeEl= $('folder-tree');
const loadingEl   = $('loading');
const loadingMsg  = $('loading-msg');
const dupPanel    = $('dup-panel');
const dupList     = $('dup-list');
const clearFilBtn = $('btn-clear-filters');

// ══════════════════════════════════════════════════════════════
//  BOOKMARK LOADING
// ══════════════════════════════════════════════════════════════
async function loadAll() {
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    loadingEl.style.display = 'flex';
    loadingMsg.textContent = 'LOADING BOOKMARKS…';
    try {
      if (!globalThis.chrome?.bookmarks?.getTree) throw new Error('Load the bookmark-os folder as an unpacked Chrome extension, then open the manager.');
      loadError = '';
      const indexed = indexTree(await chrome.bookmarks.getTree());
      ({ bookmarks, folders, rootIds, domainMap } = indexed);
      if (curFolder !== 'all' && !folders[curFolder]) curFolder = 'all';
      computeDuplicates();
      updateStats();
      buildDomainDropdown();
      renderFolderTree();
      applyFilterAndRender();
      if (dupPanel.classList.contains('open')) renderDupPanel();
    } catch (error) { loadError = error.message || 'Could not load bookmarks. Use Refresh to retry.'; toast(loadError); renderList(); }
    finally { loadingEl.style.display = 'none'; }
  })();
  try { await loadingPromise; } finally { loadingPromise = null; }
}

async function mutateRecords(records, kind, targetFolderId) {
  if (busy || !records.length) return;
  busy = true;
  loadingEl.style.display = 'flex';
  try {
    const result = await runBatch(records, bm => kind === 'delete'
      ? chrome.bookmarks.remove(bm.id)
      : chrome.bookmarks.move(bm.id, { parentId: targetFolderId }),
      (done, total) => { loadingMsg.textContent = `${kind === 'delete' ? 'REMOVING' : 'MOVING'} ${done.toLocaleString()} / ${total.toLocaleString()}`; });
    if (result.succeeded.length) undoAction = { kind, records: result.succeeded };
    selected = new Set(result.failed.map(({ item }) => item.id));
    await loadAll();
    $('btn-undo').disabled = !undoAction;
    toast(`${result.succeeded.length.toLocaleString()} ${kind === 'delete' ? 'removed' : 'moved'}${result.failed.length ? ` · ${result.failed.length} failed: ${result.failed[0].message}` : ' · Undo available'}`);
  } catch (error) { toast(error.message || 'Operation failed'); }
  finally { busy = false; loadingEl.style.display = 'none'; }
}

async function undoLastAction() {
  if (busy || !undoAction) return;
  busy = true;
  loadingEl.style.display = 'flex';
  const action = undoAction;
  try {
    // Restore siblings in their original order; created bookmark ids and dates
    // are assigned by Chrome, but titles, URLs, parent folders and order survive.
    const failed = [];
    let restored = 0;
    for (const bm of [...action.records].sort((a, b) => a.parentId.localeCompare(b.parentId) || a.index - b.index)) {
      try {
        if (action.kind === 'delete') await chrome.bookmarks.create({ parentId: bm.parentId, index: bm.index, title: bm.title, url: bm.url });
        else await chrome.bookmarks.move(bm.id, { parentId: bm.parentId, index: bm.index });
        restored++;
      } catch { failed.push(bm); }
      loadingMsg.textContent = `RESTORING ${restored.toLocaleString()} / ${action.records.length.toLocaleString()}`;
    }
    undoAction = failed.length ? { ...action, records: failed } : null;
    $('btn-undo').disabled = !undoAction;
    await loadAll();
    toast(`${restored.toLocaleString()} restored${failed.length ? ` · ${failed.length} could not be restored; retry Undo` : ''}`);
  } finally { busy = false; loadingEl.style.display = 'none'; }
}

async function exportBackup() {
  try {
    const parts = exportTreeHtml(await chrome.bookmarks.getTree());
    const url = URL.createObjectURL(new Blob(parts, { type: 'text/html' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `bookmarkos-backup-${new Date().toISOString().slice(0, 10)}.html`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Backup exported with nested and empty folders');
  } catch (error) { toast(error.message || 'Export failed'); }
}

// ══════════════════════════════════════════════════════════════
//  STATS
// ══════════════════════════════════════════════════════════════
function updateStats() {
  $('stat-total').textContent   = bookmarks.length.toLocaleString();
  $('stat-folders').textContent = (Object.keys(folders).length - 1).toLocaleString(); // subtract root
  $('stat-dups').textContent    = dupUrls.size.toLocaleString();
  $('all-count').textContent    = bookmarks.length.toLocaleString();
}

// ══════════════════════════════════════════════════════════════
//  DUPLICATE DETECTION
// ══════════════════════════════════════════════════════════════
function computeDuplicates() {
  const urlCount = Object.create(null);
  bookmarks.forEach(bm => {
    urlCount[bm.url] = (urlCount[bm.url] || 0) + 1;
  });
  dupUrls = new Set(Object.entries(urlCount).filter(([, c]) => c > 1).map(([u]) => u));
}

function renderDupPanel() {
  // Group by URL
  const groups = Object.create(null);
  bookmarks.forEach(bm => {
    if (dupUrls.has(bm.url)) {
      if (!groups[bm.url]) groups[bm.url] = [];
      groups[bm.url].push(bm);
    }
  });

  const frag = document.createDocumentFragment();
  const entries = Object.entries(groups);
  let rendered = 0;
  entries.slice(0, 200).forEach(([url, items]) => {
    if (rendered >= 500) return;
    const g = document.createElement('div');
    g.className = 'dup-group';
    g.innerHTML = `<div class="dup-url">${escHtml(url)}</div>`;
    items.slice(0, 500 - rendered).forEach(bm => {
      rendered++;
      const row = document.createElement('div');
      row.className = 'dup-entry';
      row.innerHTML = `
        <span class="dup-entry-title" title="${escHtml(bm.title)}">${escHtml(bm.title)}</span>
        <span style="font-size:10px;color:var(--text3);font-family:var(--mono);">${formatDate(bm.dateAdded)}</span>
        <button class="dup-del-btn" data-id="${bm.id}">DEL</button>
      `;
      g.appendChild(row);
    });
    frag.appendChild(g);
  });
  dupList.innerHTML = '';
  dupList.appendChild(frag);
  if (!entries.length) dupList.textContent = 'No duplicate URLs found.';
  if (entries.length > 200 || rendered >= 500) dupList.insertAdjacentHTML('beforeend', '<p class=panel-note>Showing up to 200 groups and 500 bookmarks. Cleanup applies to all duplicate groups.</p>');
}

// ══════════════════════════════════════════════════════════════
//  DOMAIN DROPDOWN
// ══════════════════════════════════════════════════════════════
function buildDomainDropdown() {
  const top = Object.entries(domainMap)
    .sort((a, b) => b[1] - a[1])
    .filter(([domain], index) => index < 100 || domain === filterDomain);
  domainSel.innerHTML = '<option value="">All domains</option>';
  top.forEach(([domain, count]) => {
    const opt = document.createElement('option');
    opt.value = domain;
    opt.textContent = `${domain} (${count})`;
    domainSel.appendChild(opt);
  });
  if (filterDomain && !domainMap[filterDomain]) filterDomain = '';
  domainSel.value = filterDomain;
}

// ══════════════════════════════════════════════════════════════
//  FOLDER TREE
// ══════════════════════════════════════════════════════════════
function countDeep(folderId) { return folders[folderId]?.total || 0; }

function getAllDescendantFolderIds(folderId) {
  const ids = new Set([folderId]);
  const q = [folderId];
  while (q.length) {
    const id = q.pop();
    const f = folders[id];
    if (f) f.childIds.forEach(cid => { ids.add(cid); q.push(cid); });
  }
  return ids;
}

function renderFolderTree() {
  // Keep the "All Bookmarks" row and append tree below
  const existing = $('all-row');
  folderTreeEl.innerHTML = '';
  folderTreeEl.appendChild(existing);

  rootIds.forEach(id => {
    const node = buildTreeNode(id, 0);
    if (node) folderTreeEl.appendChild(node);
  });

  $('all-row').onclick = () => selectFolder('all');
  $('all-row').classList.toggle('active', curFolder === 'all');
}

function buildTreeNode(folderId, depth) {
  const folder = folders[folderId];
  if (!folder) return null;

  const total = countDeep(folderId);
  const hasChildren = folder.childIds.length > 0;

  const wrap = document.createElement('div');
  wrap.className = 'ftree-node';

  const row = document.createElement('div');
  row.className = 'ftree-row' + (curFolder === folderId ? ' active' : '');
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectFolder(folderId); } });
  row.dataset.fid = folderId;
  row.innerHTML = `
    <span class="ftree-indent" style="width:${depth * 14}px"></span>
    <button class="ftree-arrow" aria-label="Expand ${escHtml(folder.title)}" ${hasChildren ? '' : 'disabled'}>${hasChildren ? '▶' : ' '}</button>
    <span class="ftree-icon">📁</span>
    <span class="ftree-name" title="${escHtml(folder.title)}">${escHtml(folder.title)}</span>
    <span class="ftree-count">${total > 0 ? total.toLocaleString() : ''}</span>
  `;
  wrap.appendChild(row);

  const children = document.createElement('div');
  children.className = 'ftree-children';
  wrap.appendChild(children);

  if (hasChildren) {
    let expanded = false;
    row.querySelector('.ftree-arrow').addEventListener('click', e => {
      e.stopPropagation();
      expanded = !expanded;
      row.querySelector('.ftree-arrow').setAttribute('aria-expanded', String(expanded));
      row.querySelector('.ftree-arrow').textContent = expanded ? '▼' : '▶';
      children.classList.toggle('open', expanded);
      if (expanded && children.children.length === 0) {
        folder.childIds.forEach(cid => {
          const child = buildTreeNode(cid, depth + 1);
          if (child) children.appendChild(child);
        });
      }
    });
  }

  row.addEventListener('click', () => selectFolder(folderId));
  return wrap;
}

function selectFolder(folderId) {
  curFolder = folderId;
  $('main').classList.remove('sidebar-open');
  $('btn-sidebar').setAttribute('aria-expanded', 'false');
  // Update active class
  document.querySelectorAll('.ftree-row.active, .all-bm-row.active').forEach(el => el.classList.remove('active'));
  if (folderId === 'all') {
    $('all-row').classList.add('active');
  } else {
    const row = document.querySelector(`.ftree-row[data-fid="${folderId}"]`);
    if (row) row.classList.add('active');
  }
  applyFilterAndRender();
}

// ══════════════════════════════════════════════════════════════
//  FILTER + SORT ENGINE
// ══════════════════════════════════════════════════════════════
function applyFilterAndRender() {
  lastClickIdx = null;
  viewport.scrollTop = 0;
  const q = searchQ.toLowerCase().trim();

  let result = bookmarks;

  // Folder scope
  if (curFolder !== 'all') {
    const ids = getAllDescendantFolderIds(curFolder);
    result = result.filter(bm => ids.has(bm.parentId));
  }

  // Full-text search
  if (q) {
    result = result.filter(bm =>
      bm.title.toLowerCase().includes(q) || bm.url.toLowerCase().includes(q) || bm.path.toLowerCase().includes(q)
    );
  }

  // Domain filter
  if (filterDomain) {
    result = result.filter(bm => bm.domain === filterDomain);
  }

  // Duplicates only
  if (showDupsOnly) {
    result = result.filter(bm => dupUrls.has(bm.url));
  }

  // Sort
  result = result.slice().sort((a, b) => {
    let va = a[sortKey] ?? '';
    let vb = b[sortKey] ?? '';
    if (typeof va === 'string') { va = va.toLowerCase(); vb = vb.toLowerCase(); }
    if (va < vb) return sortAsc ? -1 : 1;
    if (va > vb) return sortAsc ? 1 : -1;
    return 0;
  });

  filtered = result;

  // Trim selected to visible set
  const visIds = new Set(filtered.map(b => b.id));
  selected = new Set([...selected].filter(id => visIds.has(id)));

  // Update UI counts
  resultsEl.textContent = `${filtered.length.toLocaleString()} items`;
  updateBulkBar();

  // Show/hide clear filters button
  const hasFilters = q || filterDomain || showDupsOnly || curFolder !== 'all';
  clearFilBtn.style.display = hasFilters ? 'inline-flex' : 'none';

  renderList();
}

// ══════════════════════════════════════════════════════════════
//  VIRTUAL SCROLL
// ══════════════════════════════════════════════════════════════
function renderList() {
  const total = filtered.length;
  sizer.style.height = `${total * ITEM_H}px`;

  if (total === 0) {
    sizer.innerHTML = `
      <div class="empty-state">
        <div class="icon">🔍</div>
        <p>${escHtml(loadError || 'No bookmarks found. Try a different search or add a bookmark.')}</p>
      </div>`;
    return;
  }
  paintVisible();
}

function paintVisible() {
  rafPending = false;
  if (!filtered.length) { renderList(); return; }
  const scrollTop = viewport.scrollTop;
  const vpH       = viewport.clientHeight;
  const total     = filtered.length;

  const startIdx = Math.max(0, Math.floor(scrollTop / ITEM_H) - OVERSCAN);
  const endIdx   = Math.min(total, Math.ceil((scrollTop + vpH) / ITEM_H) + OVERSCAN);

  const frag = document.createDocumentFragment();
  for (let i = startIdx; i < endIdx; i++) {
    const el = createItem(filtered[i], i);
    el.style.position = 'absolute';
    el.style.top      = `${i * ITEM_H}px`;
    el.style.left     = '0';
    el.style.right    = '0';
    el.style.height   = `${ITEM_H}px`;
    frag.appendChild(el);
  }

  sizer.innerHTML = '';
  sizer.appendChild(frag);
  rafPending = false;
}

viewport.addEventListener('scroll', () => {
  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(paintVisible);
  }
}, { passive: true });

new ResizeObserver(() => { requestAnimationFrame(paintVisible); }).observe(viewport);

// ══════════════════════════════════════════════════════════════
//  BOOKMARK ITEM RENDERING
// ══════════════════════════════════════════════════════════════
function createItem(bm, idx) {
  const el = document.createElement('div');
  const isDup = dupUrls.has(bm.url);
  const isSel = selected.has(bm.id);

  el.className = 'bm-item' + (isSel ? ' selected' : '') + (isDup ? ' dup-item' : '');
  el.dataset.id  = bm.id;
  el.dataset.idx = idx;

  const favicon = globalThis.chrome?.runtime?.id && openableUrl(bm.url)
    ? `${chrome.runtime.getURL('_favicon/')}?pageUrl=${encodeURIComponent(bm.url)}&size=32`
    : '';
  el.tabIndex = 0;
  el.setAttribute('aria-label', bm.title);
  el.addEventListener('keydown', e => {
    if (e.target !== el) return;
    if (e.key === ' ') { e.preventDefault(); handleCheckbox(bm.id, idx, e.shiftKey); }
    if (e.key === 'Enter') { e.preventDefault(); openBookmark(bm); }
    if (e.key === 'F2') { e.preventDefault(); showRenameModal(bm); }
  });

  el.innerHTML = `
    <div class="bm-check">
      <input type="checkbox" class="chk" ${isSel ? 'checked' : ''} aria-label="Select ${escHtml(bm.title)}">
    </div>
    ${favicon
      ? `<img class="bm-favicon" src="${escHtml(favicon)}" alt="" loading="lazy">`
      : `<span style="width:16px;flex-shrink:0"></span>`
    }
    <div class="bm-info">
      <div class="bm-title">
        ${escHtml(truncate(bm.title, 120))}
        ${isDup ? '<span class="dup-badge">DUP</span>' : ''}
      </div>
      <div class="bm-url">${escHtml(bm.url)}</div>
      ${bm.path ? `<div class="bm-path">${escHtml(bm.path)}</div>` : ''}
    </div>
    <div class="bm-meta">
      <div class="bm-date">${formatDate(bm.dateAdded)}</div>
    </div>
    <div class="bm-actions">
      <button class="action-btn open-btn" aria-label="Open ${escHtml(bm.title)}" title="Open in new tab">↗</button>
      <button class="action-btn edit-btn" aria-label="Edit ${escHtml(bm.title)}" title="Edit bookmark">✎</button>
      <button class="action-btn del-btn" aria-label="Delete ${escHtml(bm.title)}" title="Delete">✕</button>
    </div>
  `;

  el.querySelector('.bm-favicon')?.addEventListener('error', e => { e.target.style.visibility = 'hidden'; });
  // Checkbox
  el.querySelector('.chk').addEventListener('click', e => {
    e.stopPropagation();
    handleCheckbox(bm.id, idx, e.shiftKey);
  });

  // Open button
  el.querySelector('.open-btn').addEventListener('click', e => {
    e.stopPropagation();
    openBookmark(bm);
  });

  // Edit title
  el.querySelector('.edit-btn').addEventListener('click', e => {
    e.stopPropagation();
    showRenameModal(bm);
  });

  // Delete
  el.querySelector('.del-btn').addEventListener('click', e => {
    e.stopPropagation();
    showConfirm(`Delete "${truncate(bm.title, 60)}" from Chrome?`, () => mutateRecords([bm], 'delete'));

  });

  // Row click → select
  el.addEventListener('click', e => {
    if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
    handleCheckbox(bm.id, idx, e.shiftKey);
  });

  return el;
}

// ══════════════════════════════════════════════════════════════
//  SELECTION
// ══════════════════════════════════════════════════════════════
function handleCheckbox(id, idx, isShift) {
  if (isShift && lastClickIdx !== null && lastClickIdx !== idx) {
    const lo = Math.min(lastClickIdx, idx);
    const hi = Math.max(lastClickIdx, idx);
    const newState = !selected.has(id); // toggle based on clicked item
    for (let i = lo; i <= hi; i++) {
      if (filtered[i]) {
        if (newState) selected.add(filtered[i].id);
        else selected.delete(filtered[i].id);
      }
    }
  } else {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
  }
  lastClickIdx = idx;
  updateBulkBar();
  paintVisible();
}

function updateBulkBar() {
  selCountEl.textContent = `${selected.size.toLocaleString()} SELECTED`;
  bulkBar.classList.toggle('visible', selected.size > 0);
}

// ══════════════════════════════════════════════════════════════
//  BULK OPERATIONS
// ══════════════════════════════════════════════════════════════
function openBookmark(bm) {
  const url = openableUrl(bm.url);
  if (!url) { toast('This bookmark uses a blocked or invalid URL.'); return; }
  void chrome.tabs.create({ url }).catch(error => toast(error.message));
}

function deleteSelected() {
  if (selected.size === 0 || busy) return;
  const records = bookmarks.filter(bm => selected.has(bm.id));
  showConfirm(`Delete ${records.length.toLocaleString()} bookmarks from Chrome? Undo is available until this manager is closed or another bulk action replaces it.`, () => mutateRecords(records, 'delete'));
}

function moveSelectedTo(targetFolderId) {
  return mutateRecords(bookmarks.filter(bm => selected.has(bm.id) && bm.parentId !== targetFolderId), 'move', targetFolderId);
}

// ══════════════════════════════════════════════════════════════
//  AUTO-ORGANIZE BY DOMAIN
// ══════════════════════════════════════════════════════════════
function showAutoOrganize() {
  // Find domains with 5+ bookmarks
  const topDomains = Object.entries(domainMap)
    .filter(([, c]) => c >= 5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30);

  if (topDomains.length === 0) {
    showConfirm('No domains have 5+ bookmarks to auto-organize.', null, true);
    return;
  }

  const bodyHtml = `
    <p style="color:var(--text1);font-size:12px;margin-bottom:12px;">
      This will create folders for the top ${topDomains.length} domains and move their bookmarks in.
      Choose a parent folder:
    </p>
    <div class="modal-tree" id="auto-org-tree"></div>
    <div class="sep"></div>
    <p style="font-size:11px;color:var(--text2);">Domains to organize:</p>
    <div style="max-height:120px;overflow-y:auto;margin-top:6px;">
      ${topDomains.map(([d, c]) =>
        `<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:11px;">
          <span style="color:var(--text1);">${escHtml(d)}</span>
          <span style="color:var(--text2);font-family:var(--mono);">${c}</span>
        </div>`
      ).join('')}
    </div>
  `;

  openModal('⚡ AUTO-ORGANIZE BY DOMAIN', bodyHtml, [
    { label: 'ORGANIZE', cls: 'btn primary', id: 'confirm-auto-org' },
    { label: 'CANCEL', cls: 'btn', id: 'cancel-modal' },
  ]);

  // Build folder picker in tree
  let selectedParent = null;
  const treeEl = $('auto-org-tree');
  buildFolderPicker(treeEl, rootIds, 0, fid => { selectedParent = fid; });

  $('confirm-auto-org').addEventListener('click', async () => {
    if (!selectedParent) { toast('Please select a target folder'); return; }
    closeModal();
    await runAutoOrganize(topDomains.map(([d]) => d), selectedParent);
  });
}

async function runAutoOrganize(domains, parentId) {
  if (busy) return;
  busy = true;
  loadingEl.style.display = 'flex';
  loadingMsg.textContent = 'ORGANIZING…';
  try {
    const targets = new Map();
    let folderFailures = 0;
    for (const domain of domains) {
      try {
        const existing = Object.values(folders).find(f => f.parentId === parentId && f.title === domain);
        const folder = existing || await chrome.bookmarks.create({ parentId, title: domain });
        targets.set(domain, folder.id);
      } catch { folderFailures++; }
    }
    const records = bookmarks.filter(bm => targets.has(bm.domain) && bm.parentId !== targets.get(bm.domain));
    const result = await runBatch(records, bm => chrome.bookmarks.move(bm.id, { parentId: targets.get(bm.domain) }),
      (done, total) => { loadingMsg.textContent = `ORGANIZING ${done.toLocaleString()} / ${total.toLocaleString()}`; });
    if (result.succeeded.length) undoAction = { kind: 'move', records: result.succeeded };
    $('btn-undo').disabled = !undoAction;
    await loadAll();
    toast(`Organized ${result.succeeded.length.toLocaleString()} bookmarks · ${result.failed.length} moves and ${folderFailures} folders failed`);
  } finally { busy = false; loadingEl.style.display = 'none'; }
}

// ══════════════════════════════════════════════════════════════
//  DELETE ALL DUPLICATES
// ══════════════════════════════════════════════════════════════
function deleteAllDuplicates() {
  const ids = new Set(duplicateIds(bookmarks));
  if (!ids.size) { toast('No duplicates found'); return; }
  const records = bookmarks.filter(bm => ids.has(bm.id));
  showConfirm(`Delete ${records.length.toLocaleString()} duplicate bookmarks from Chrome? The oldest copy of each exact URL stays. Undo will be available.`, () => mutateRecords(records, 'delete'));
}

// ══════════════════════════════════════════════════════════════
//  FOLDER PICKER (reusable)
// ══════════════════════════════════════════════════════════════
function buildFolderPicker(container, folderIds, depth, onSelect) {
  folderIds.forEach(fid => {
    const f = folders[fid];
    if (!f) return;
    const row = document.createElement('div');
    row.className = 'mtree-row';
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); } });
    row.style.paddingLeft = `${8 + depth * 14}px`;
    row.innerHTML = `<span>📁</span><span>${escHtml(f.title)}</span>`;
    row.addEventListener('click', () => {
      document.querySelectorAll('.mtree-row.selected').forEach(el => el.classList.remove('selected'));
      row.classList.add('selected');
      onSelect(fid);
    });
    container.appendChild(row);
    if (f.childIds.length) buildFolderPicker(container, f.childIds, depth + 1, onSelect);
  });
}

// ══════════════════════════════════════════════════════════════
//  MOVE MODAL
// ══════════════════════════════════════════════════════════════
function showMoveModal() {
  const bodyHtml = `
    <p style="color:var(--text1);font-size:12px;margin-bottom:10px;">
      Move ${selected.size} bookmarks to:
    </p>
    <div class="modal-tree" id="move-tree"></div>
  `;
  openModal('📁 MOVE TO FOLDER', bodyHtml, [
    { label: 'MOVE', cls: 'btn primary', id: 'confirm-move' },
    { label: 'CANCEL', cls: 'btn', id: 'cancel-modal' },
  ]);

  let targetFolder = null;
  buildFolderPicker($('move-tree'), rootIds, 0, fid => { targetFolder = fid; });

  $('confirm-move').addEventListener('click', async () => {
    if (!targetFolder) { toast('Please select a folder'); return; }
    closeModal();
    await moveSelectedTo(targetFolder);
  });
}

// ══════════════════════════════════════════════════════════════
//  NEW FOLDER MODAL
// ══════════════════════════════════════════════════════════════
function showNewFolderModal() {
  const bodyHtml = `
    <label for="new-folder-name" style="font-size:12px;color:var(--text1);">Folder name:</label>
    <input class="modal-input" id="new-folder-name" placeholder="My Folder" maxlength="100">
    <div class="sep"></div>
    <label style="font-size:12px;color:var(--text1);">Parent folder:</label>
    <div class="modal-tree" id="new-folder-tree" style="margin-top:8px;"></div>
  `;
  openModal('📁 NEW FOLDER', bodyHtml, [
    { label: 'CREATE', cls: 'btn primary', id: 'confirm-new-folder' },
    { label: 'CANCEL', cls: 'btn', id: 'cancel-modal' },
  ]);
  setTimeout(() => $('new-folder-name').focus(), 50);

  let parentFolder = curFolder !== 'all' ? curFolder : rootIds[0]; // Bookmarks bar default
  buildFolderPicker($('new-folder-tree'), rootIds, 0, fid => { parentFolder = fid; });

  $('confirm-new-folder').addEventListener('click', async () => {
    const name = $('new-folder-name').value.trim();
    if (!name) { toast('Enter a folder name'); return; }
    try { await chrome.bookmarks.create({ parentId: parentFolder, title: name }); }
    catch (error) { toast(error.message); return; }
    closeModal();
    await loadAll();
    toast(`Folder "${name}" created`);
  });
}

// ══════════════════════════════════════════════════════════════
//  RENAME BOOKMARK MODAL
// ══════════════════════════════════════════════════════════════
function showRenameModal(bm = { title: '', url: '' }) {
  const bodyHtml = `
    <label for="rename-title" style="font-size:12px;color:var(--text1);">Title:</label>
    <input class="modal-input" id="rename-title" value="${escHtml(bm.title)}" maxlength="300">
    <label for="rename-url" style="font-size:12px;color:var(--text1);display:block;margin-top:10px;">URL:</label>
    <input class="modal-input" id="rename-url" value="${escHtml(bm.url)}">
  `;
  openModal(bm.id ? 'EDIT BOOKMARK' : 'ADD BOOKMARK', bodyHtml, [
    { label: 'SAVE', cls: 'btn primary', id: 'confirm-rename' },
    { label: 'CANCEL', cls: 'btn', id: 'cancel-modal' },
  ]);
  setTimeout(() => $('rename-title').focus(), 50);

  $('confirm-rename').addEventListener('click', async () => {
    const newTitle = $('rename-title').value.trim();
    const newUrl   = $('rename-url').value.trim();
    if (!openableUrl(newUrl)) { toast('Enter a complete, supported URL such as https://example.com'); return; }
    try {
      if (bm.id) await chrome.bookmarks.update(bm.id, { title: newTitle || newUrl, url: newUrl });
      else await chrome.bookmarks.create({ parentId: curFolder !== 'all' ? curFolder : rootIds[0], title: newTitle || newUrl, url: newUrl });
    } catch (error) { toast(error.message); return; }
    closeModal();
    await loadAll();
    toast(bm.id ? 'Bookmark updated' : 'Bookmark added');
  });
}

// ══════════════════════════════════════════════════════════════
//  MODAL SYSTEM
// ══════════════════════════════════════════════════════════════
function openModal(title, bodyHtml, buttons = []) {
  priorFocus = document.activeElement;
  $('modal-title').textContent = title;
  $('modal-body').innerHTML = bodyHtml;
  $('modal-footer').innerHTML = buttons.map(b =>
    `<button class="${b.cls}" id="${b.id}">${b.label}</button>`
  ).join('');
  $('modal-overlay').classList.add('open');
  ($('modal-body').querySelector('input') || $('cancel-modal') || $('modal-close')).focus();

  // Generic cancel
  const cancelBtn = $('cancel-modal');
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
}

function closeModal() {
  const wasOpen = $('modal-overlay').classList.contains('open');
  $('modal-overlay').classList.remove('open');
  if (wasOpen && priorFocus?.isConnected) priorFocus.focus();
}

function showConfirm(msg, onConfirm, infoOnly = false) {
  const bodyHtml = `<p style="color:var(--text1);font-size:13px;">${escHtml(msg)}</p>`;
  const btns = infoOnly
    ? [{ label: 'OK', cls: 'btn primary', id: 'cancel-modal' }]
    : [
        { label: 'CONFIRM', cls: 'btn primary', id: 'confirm-action' },
        { label: 'CANCEL',  cls: 'btn',         id: 'cancel-modal' },
      ];
  openModal('CONFIRM', bodyHtml, btns);
  if (!infoOnly) {
    $('confirm-action').addEventListener('click', async () => {
      closeModal();
      try { await onConfirm(); } catch (error) { toast(error.message || 'Operation failed'); }
    });
  }
}

// ══════════════════════════════════════════════════════════════
//  TOAST NOTIFICATION
// ══════════════════════════════════════════════════════════════
let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// ══════════════════════════════════════════════════════════════
//  UTILITIES
// ══════════════════════════════════════════════════════════════
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(str, n) {
  return str.length > n ? str.slice(0, n) + '…' : str;
}

function formatDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ══════════════════════════════════════════════════════════════
//  EVENT WIRING
// ══════════════════════════════════════════════════════════════

// Search — debounced
let searchDebounce;
searchEl.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    searchQ = searchEl.value;
    applyFilterAndRender();
  }, 120);
});

// Ctrl+F focus search
document.addEventListener('keydown', e => {
  const modalOpen = $('modal-overlay').classList.contains('open');
  if (modalOpen) {
    if (e.key === 'Escape') { e.preventDefault(); closeModal(); }
    if (e.key === 'Tab') {
      const items = [...$('modal').querySelectorAll('button:not(:disabled), input, select, [tabindex="0"]')];
      const first = items[0], last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    return;
  }
  if (busy) return;
  const inField = e.target.closest('input, textarea, select, [contenteditable]');
  if (!inField && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault(); selected = new Set(filtered.map(bm => bm.id)); updateBulkBar(); paintVisible();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'f' || !inField && e.key === '/') {
    e.preventDefault();
    searchEl.focus();
    searchEl.select();
  }
  if (e.key === 'Escape') {
    closeModal();
    dupPanel.classList.remove('open');
    $('btn-show-dups').classList.remove('active');
    selected.clear(); updateBulkBar(); paintVisible();
  }
  // Delete selected with Delete key
  if (e.key === 'Delete' && selected.size > 0 && !inField) {
    deleteSelected();
  }
});

// Sort
sortSel.addEventListener('change', () => {
  const [key, dir] = sortSel.value.split('-');
  sortKey = key;
  sortAsc = dir === 'asc';
  applyFilterAndRender();
});

// Domain filter
domainSel.addEventListener('change', () => {
  filterDomain = domainSel.value;
  applyFilterAndRender();
});

// Clear filters
clearFilBtn.addEventListener('click', () => {
  searchEl.value = '';
  searchQ = '';
  filterDomain = '';
  domainSel.value = '';
  showDupsOnly = false;
  curFolder = 'all';
  $('btn-show-dups').classList.remove('active');
  document.querySelectorAll('.ftree-row.active, .all-bm-row.active').forEach(el => el.classList.remove('active'));
  $('all-row').classList.add('active');
  applyFilterAndRender();
});

// Select all visible
$('btn-select-all').addEventListener('click', () => {
  if (selected.size === filtered.length) {
    selected.clear();
  } else {
    filtered.forEach(bm => selected.add(bm.id));
  }
  updateBulkBar();
  paintVisible();
});

// Deselect all
$('btn-deselect').addEventListener('click', () => {
  selected.clear();
  updateBulkBar();
  paintVisible();
});

// Bulk delete
$('btn-del-sel').addEventListener('click', deleteSelected);

// Bulk move
$('btn-move-sel').addEventListener('click', showMoveModal);

// Find duplicates
$('btn-show-dups').addEventListener('click', () => {
  const isOn = dupPanel.classList.toggle('open');
  $('btn-show-dups').classList.toggle('active', isOn);
  if (isOn) renderDupPanel();
});

$('btn-close-dups').addEventListener('click', () => {
  dupPanel.classList.remove('open');
  $('btn-show-dups').classList.remove('active');
});

$('btn-del-all-dups').addEventListener('click', deleteAllDuplicates);

// Delete individual dup from panel
dupList.addEventListener('click', e => {
  const button = e.target.closest('.dup-del-btn');
  if (!button) return;
  const bm = bookmarks.find(row => row.id === button.dataset.id);
  if (bm) showConfirm(`Delete "${truncate(bm.title, 60)}" from Chrome?`, () => mutateRecords([bm], 'delete'));
});

// Show dups only filter (via dup badge click — handled inline)
// Could also add a toolbar button

// Auto-organize
$('btn-auto-org').addEventListener('click', showAutoOrganize);

// New folder
$('btn-new-folder').addEventListener('click', showNewFolderModal);

$('btn-add').addEventListener('click', () => showRenameModal());
$('btn-export').addEventListener('click', exportBackup);
$('btn-undo').addEventListener('click', undoLastAction);
$('btn-sidebar').addEventListener('click', () => {
  const open = $('main').classList.toggle('sidebar-open');
  $('btn-sidebar').setAttribute('aria-expanded', String(open));
});

// Refresh
$('btn-refresh').addEventListener('click', loadAll);

// Modal close button
$('modal-close').addEventListener('click', closeModal);

// Modal overlay click-outside
$('modal-overlay').addEventListener('click', e => {
  if (e.target === $('modal-overlay')) closeModal();
});

// ══════════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════════
loadAll();

// Changes made elsewhere in Chrome refresh the manager; bulk API events are
// coalesced so a 50k move never triggers 50k complete reloads.
const scheduleReload = () => {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => { if (busy || loadingPromise) scheduleReload(); else void loadAll(); }, 350);
};
if (globalThis.chrome?.bookmarks) {
  for (const name of ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered', 'onImportEnded']) chrome.bookmarks[name]?.addListener(scheduleReload);
}
