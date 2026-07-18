// Background service worker - stays alive and proxies API calls

function getServerUrl() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["serverUrl"], (d) => resolve(d.serverUrl || "https://captcha-solve.vercel.app"));
  });
}

function getKeys() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["keys"], (d) => resolve(d.keys || {}));
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
        const data = await resp.json();
        sendResponse(data);
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }
});
