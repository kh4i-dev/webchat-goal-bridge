// Relay duy nhất content -> wgb serve (tránh mixed-content/CSP của trang chat).
const DEFAULTS = { serverUrl: 'http://127.0.0.1:8787', token: '' };

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(DEFAULTS, (s) => chrome.storage.sync.set(s));
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.path !== 'string') return false;
  (async () => {
    const cfg = await chrome.storage.sync.get(DEFAULTS);
    const url = cfg.serverUrl.replace(/\/$/, '') + msg.path;
    const res = await fetch(url, {
      method: msg.method || 'GET',
      headers: {
        'content-type': 'application/json',
        ...(cfg.token ? { 'x-wgb-token': cfg.token } : {})
      },
      body: msg.body !== undefined ? JSON.stringify(msg.body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    sendResponse({ ok: res.ok, status: res.status, data });
  })().catch((err) => sendResponse({ ok: false, error: String(err) }));
  return true; // giữ kênh mở cho sendResponse async
});
