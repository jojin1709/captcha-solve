// Background service worker — minimal, keeps alive for messaging

let keepAliveInterval;
chrome.runtime.onInstalled.addListener(() => {
  keepAliveInterval = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 25000);
});
chrome.runtime.onStartup.addListener(() => {
  keepAliveInterval = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 25000);
});

// Minimal message handler — popup does all the heavy lifting
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "PING") {
    sendResponse({ ok: true });
    return true;
  }
});
