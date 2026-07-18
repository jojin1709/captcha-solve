// Background service worker - keep alive and proxy API calls

// Keep service worker alive
let keepAliveInterval;
chrome.runtime.onInstalled.addListener(() => {
  keepAliveInterval = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});
  }, 25000);
});

chrome.runtime.onStartup.addListener(() => {
  keepAliveInterval = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});
  }, 25000);
});

function getServerUrl() {
  return new Promise((r) => chrome.storage.local.get(["serverUrl"], (d) => r(d.serverUrl || "https://captcha-solve.vercel.app")));
}
function getKeys() {
  return new Promise((r) => chrome.storage.local.get(["keys"], (d) => r(d.keys || {})));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // API proxy
  if (msg.type === "API_REQUEST") {
    (async () => {
      try {
        const serverUrl = await getServerUrl();
        const keys = await getKeys();
        const body = { ...msg.body, api_keys: keys };
        const resp = await fetch(`${serverUrl}${msg.path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        sendResponse(await resp.json());
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  // Screenshot capture
  if (msg.type === "CAPTURE_TAB") {
    chrome.tabs.captureVisibleTab(null, { format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
      } else {
        const base64 = dataUrl.split(",")[1];
        sendResponse({ base64 });
      }
    });
    return true;
  }
});
