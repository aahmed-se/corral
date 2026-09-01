async function showCorral() {
  const url = chrome.runtime.getURL('index.html');
  const [existing] = await chrome.tabs.query({ url });
  if (existing?.id !== undefined) {
    if (existing.windowId !== undefined) await chrome.windows.update(existing.windowId, { focused: true });
    await chrome.tabs.update(existing.id, { active: true });
    return;
  }
  await chrome.tabs.create({ url });
}

chrome.action.onClicked.addListener(() => {
  void showCorral();
});
