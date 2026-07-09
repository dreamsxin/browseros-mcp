chrome.runtime.onInstalled.addListener(async () => {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    await chrome.sidePanel.setOptions({ path: 'sidepanel.html' });
  } catch (error) {
    console.warn('[browser-control-agent-panel] failed to configure side panel', error);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (_error) {
    // Ignore startup races.
  }
});
