// Background service worker

// Keep alive
let keepAliveInterval;
chrome.runtime.onInstalled.addListener(() => {
  keepAliveInterval = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 25000);
});
chrome.runtime.onStartup.addListener(() => {
  keepAliveInterval = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 25000);
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
        sendResponse({ base64: dataUrl.split(",")[1] });
      }
    });
    return true;
  }

  // Inject solver into reCAPTCHA iframe
  if (msg.type === "INJECT_RECAPTCHA_SOLVER") {
    const { frameId, tileIndices } = msg;
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id, frameIds: [frameId] },
      func: (indices) => {
        const tiles = document.querySelectorAll('td[role="button"], .rc-imageselect-tile, table.rc-imageselect-table-33 td');
        indices.forEach(i => {
          if (tiles[i]) {
            tiles[i].click();
          }
        });
        setTimeout(() => {
          const btn = document.querySelector('#recaptcha-verify-button');
          if (btn) btn.click();
        }, 1000);
      },
      args: [tileIndices],
    }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  // Get all frame IDs for a tab
  if (msg.type === "GET_FRAMES") {
    chrome.scripting.getAllFrames({ tabId: sender.tab.id }, (frames) => {
      sendResponse({ frames: frames || [] });
    });
    return true;
  }
});
