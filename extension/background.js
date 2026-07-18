// Background service worker — handles screenshot, AI, and frame injection

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
        msg.body.api_keys = keys;
        const resp = await fetch(`${serverUrl}${msg.path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(msg.body),
        });
        sendResponse(await resp.json());
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  // Screenshot
  if (msg.type === "CAPTURE_TAB") {
    chrome.tabs.captureVisibleTab(null, { format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError || !dataUrl) sendResponse({ error: "capture failed" });
      else sendResponse({ base64: dataUrl.split(",")[1] });
    });
    return true;
  }

  // Full solve: screenshot → AI → inject clicks
  if (msg.type === "SOLVE_RECAPTCHA") {
    (async () => {
      try {
        // 1. Capture screenshot
        const screenshot = await new Promise((resolve) => {
          chrome.tabs.captureVisibleTab(null, { format: "png" }, (dataUrl) => {
            if (chrome.runtime.lastError || !dataUrl) resolve(null);
            else resolve(dataUrl.split(",")[1]);
          });
        });

        if (!screenshot) {
          sendResponse({ error: "Screenshot failed" });
          return;
        }

        // 2. Send to AI (keys come directly from popup message)
        const keys = msg.keys || {};
        const serverUrl = await getServerUrl();
        const resp = await fetch(`${serverUrl}/solve/image`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_keys: keys,
            image_base64: screenshot,
            prompt: `This is a reCAPTCHA image challenge. The instruction says to "Select all squares with [object]".
The grid is 4x4 or 3x3. Numbered left-to-right, top-to-bottom starting from 1.
Return ONLY the numbers of squares containing the target object, separated by commas.
Example: 1,3,7
If none match, return: 0`,
          }),
        });
        const aiResult = await resp.json();

        if (aiResult.error) {
          sendResponse({ error: aiResult.error });
          return;
        }

        // 3. Parse tile numbers
        const nums = (aiResult.answer || "").match(/\d+/g);
        if (!nums || nums.length === 0 || (nums.length === 1 && nums[0] === "0")) {
          sendResponse({ error: "AI found no matching tiles", aiAnswer: aiResult.answer });
          return;
        }

        const indices = nums.map(n => parseInt(n) - 1);

        // 4. Inject clicks into ALL frames
        const tabId = sender.tab ? sender.tab.id : msg.tabId;
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: (tileIndices) => {
            const tiles = document.querySelectorAll(
              'td[role="button"], .rc-imageselect-tile, table.rc-imageselect-table-33 td, table.rc-imageselect-table-44 td'
            );
            if (tiles.length === 0) return false;
            tileIndices.forEach(i => { if (tiles[i]) tiles[i].click(); });
            setTimeout(() => {
              const btn = document.querySelector('#recaptcha-verify-button, .rc-button-default');
              if (btn) btn.click();
            }, 1500);
            return true;
          },
          args: [indices],
        });

        sendResponse({ success: true, tiles: indices, aiAnswer: aiResult.answer });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }
});
