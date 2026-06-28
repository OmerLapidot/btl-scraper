// background.js — service worker.
//
// The content script (running on ps.btl.gov.il) fetches the read-only data using
// the user's LIVE session, then hands it here. We stash it in chrome.storage.session
// — which is IN-MEMORY ONLY (wiped when the browser closes, never written to disk)
// — and open the dashboard tab. The dashboard page reads it back from there.
//
// Nothing is ever sent off the device: there is no network code in this extension
// other than the content script's same-origin calls to the portal itself.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'BTL_DATA') return;

  (async () => {
    try {
      if (!msg.data || typeof msg.data !== 'object') throw new Error('no data received');
      await chrome.storage.session.set({ btlData: msg.data, btlMeta: msg.meta || {} });
      await chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
      sendResponse({ ok: true });
    } catch (e) {
      console.error('[BTL] failed to open dashboard:', e);
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();

  return true; // keep the message channel open for the async sendResponse
});
