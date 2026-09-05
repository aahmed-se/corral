'use strict';

async function showBookmarkOS() {
  const url = chrome.runtime.getURL('app.html');
  const [existing] = await chrome.tabs.query({ url });
  if (existing?.id !== undefined) {
    await chrome.windows.update(existing.windowId, { focused: true });
    await chrome.tabs.update(existing.id, { active: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

// Coalesce rapid clicks while finding or creating the manager tab.
let opening = null;
chrome.action.onClicked.addListener(() => {
  opening ??= showBookmarkOS()
    .catch(error => console.error('Could not open BookmarkOS:', error))
    .finally(() => { opening = null; });
});
