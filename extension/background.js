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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // API proxy
  if (msg.type === "API_REQUEST") {
    (async () => {
      try {
        const serverUrl = await getServerUrl();
        msg.body.api_keys = msg.keys || {};
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

  // Grid challenge: screenshot → AI → click tiles
  if (msg.type === "SOLVE_RECAPTCHA") {
    (async () => {
      try {
        const screenshot = await new Promise((resolve) => {
          chrome.tabs.captureVisibleTab(null, { format: "png" }, (dataUrl) => {
            if (chrome.runtime.lastError || !dataUrl) resolve(null);
            else resolve(dataUrl.split(",")[1]);
          });
        });
        if (!screenshot) { sendResponse({ error: "Screenshot failed" }); return; }

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
Example: 1,3,7. If none match, return: 0`,
          }),
        });
        const aiResult = await resp.json();
        if (aiResult.error) { sendResponse({ error: aiResult.error }); return; }

        const nums = (aiResult.answer || "").match(/\d+/g);
        if (!nums || nums.length === 0 || (nums.length === 1 && nums[0] === "0")) {
          sendResponse({ error: "AI found no matching tiles", aiAnswer: aiResult.answer });
          return;
        }
        const indices = nums.map(n => parseInt(n) - 1);

        const tabId = sender.tab ? sender.tab.id : msg.tabId;
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: (tileIndices) => {
            const tiles = document.querySelectorAll(
              'td[role="button"], .rc-imageselect-tile, table td'
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
      } catch (e) { sendResponse({ error: e.message }); }
    })();
    return true;
  }

  // Drag challenge: screenshot → AI → drag element
  if (msg.type === "SOLVE_DRAG_CHALLENGE") {
    (async () => {
      try {
        const screenshot = await new Promise((resolve) => {
          chrome.tabs.captureVisibleTab(null, { format: "png" }, (dataUrl) => {
            if (chrome.runtime.lastError || !dataUrl) resolve(null);
            else resolve(dataUrl.split(",")[1]);
          });
        });
        if (!screenshot) { sendResponse({ error: "Screenshot failed" }); return; }

        const keys = msg.keys || {};
        const serverUrl = await getServerUrl();
        const resp = await fetch(`${serverUrl}/solve/image`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_keys: keys,
            image_base64: screenshot,
            prompt: `This is a drag-and-drop captcha challenge. The instruction says: "Drag ONE character to the matching character behind the lines."

Look at the image:
- LEFT side: animal characters with "Move" buttons (draggable items)
- RIGHT side: animal characters behind fence/grid lines (targets)

Which animal on the LEFT matches which animal on the RIGHT?

Return ONLY a JSON object:
{"source": 0, "target_x": 250, "target_y": 150}

- source: 0=top animal, 1=middle, 2=bottom
- target_x: horizontal pixel position of matching animal on the right (estimate 0-400)
- target_y: vertical pixel position (estimate 0-300)

If you cannot determine, return: {"skip": true}
Return ONLY the JSON.`,
          }),
        });
        const aiResult = await resp.json();
        if (aiResult.error) { sendResponse({ error: aiResult.error }); return; }

        // Parse AI response
        let solution;
        try {
          const jsonMatch = (aiResult.answer || "").match(/\{[\s\S]*?\}/);
          if (jsonMatch) solution = JSON.parse(jsonMatch[0]);
        } catch (e) { sendResponse({ error: "Could not parse AI response" }); return; }

        if (!solution || solution.skip) {
          sendResponse({ error: "AI could not determine drag solution" });
          return;
        }

        // Inject drag into the challenge frame
        const tabId = sender.tab ? sender.tab.id : msg.tabId;
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: (sol) => {
            // Find the challenge container
            const challenge = document.querySelector('.rc-imageselect-challenge, .challenge-container, [class*="challenge"]');
            if (!challenge) return false;

            // Find Move buttons on the left
            const moveButtons = document.querySelectorAll('.move-button, [class*="move"], button');
            let sourceEl = null;
            let sourceIndex = 0;

            // Try to find the draggable source by index
            const draggables = document.querySelectorAll('[draggable], .draggable, [class*="drag"]');
            if (draggables.length > sol.source) {
              sourceEl = draggables[sol.source];
            }

            // If no draggable found, try clicking the Move button
            if (!sourceEl && moveButtons.length > sol.source) {
              sourceEl = moveButtons[sol.source];
              sourceEl.click();
            }

            if (!sourceEl) return false;

            // Get source position
            const srcRect = sourceEl.getBoundingClientRect();
            const startX = srcRect.left + srcRect.width / 2;
            const startY = srcRect.top + srcRect.height / 2;

            // Calculate target position (relative to viewport)
            const tgtX = sol.target_x;
            const tgtY = sol.target_y;

            // Perform drag with human-like movement
            const mouseDown = new MouseEvent('mousedown', { clientX: startX, clientY: startY, bubbles: true });
            sourceEl.dispatchEvent(mouseDown);

            // Move in steps
            const steps = 15;
            for (let i = 1; i <= steps; i++) {
              const x = startX + (tgtX - startX) * (i / steps);
              const y = startY + (tgtY - startY) * (i / steps);
              document.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
            }

            // Release
            document.dispatchEvent(new MouseEvent('mouseup', { clientX: tgtX, clientY: tgtY, bubbles: true }));

            return true;
          },
          args: [solution],
        });

        sendResponse({ success: true, solution });
      } catch (e) { sendResponse({ error: e.message }); }
    })();
    return true;
  }

  // Skip button click
  if (msg.type === "CLICK_SKIP") {
    const tabId = sender.tab ? sender.tab.id : msg.tabId;
    chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const skip = document.querySelector('.button-submit, [class*="skip"], button');
        if (skip && skip.textContent.toLowerCase().includes('skip')) {
          skip.click();
          return true;
        }
        return false;
      },
    }, () => sendResponse({ ok: true }));
    return true;
  }
});
