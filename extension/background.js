// Background service worker: proxies API calls from content script to local server
// Passes API keys from extension settings to the server

function getServerUrl() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["serverUrl"], (data) => {
      resolve(data.serverUrl || "http://127.0.0.1:5555");
    });
  });
}

function getKeys() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["keys"], (data) => {
      resolve(data.keys || {});
    });
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "API_REQUEST") {
    (async () => {
      try {
        const serverUrl = await getServerUrl();
        const keys = await getKeys();

        // Merge API keys into the request body
        const body = { ...msg.body, api_keys: keys };

        const resp = await fetch(`${serverUrl}${msg.path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await resp.json();
        sendResponse(data);
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true; // keep channel open for async response
  }
});
