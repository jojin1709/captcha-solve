// ---- Tab switching ----
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(`panel-${tab.dataset.tab}`).classList.add("active");
  });
});

const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const autoSolve = document.getElementById("autoSolve");
const engineSelect = document.getElementById("engine");
const solveBtn = document.getElementById("solveBtn");
const logDiv = document.getElementById("log");
const saveBtn = document.getElementById("saveBtn");
const savedMsg = document.getElementById("savedMsg");
const serverUrlInput = document.getElementById("serverUrl");

const keyIds = {
  openai: "keyOpenai", xai: "keyXai", groq: "keyGroq",
  openrouter: "keyOpenrouter", gemini: "keyGemini", twocaptcha: "keyTwocaptcha",
};

function log(msg, cls = "") {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logDiv.prepend(line);
}

function getKeys() {
  const keys = {};
  for (const [k, id] of Object.entries(keyIds)) {
    const el = document.getElementById(id);
    if (el && el.value.trim()) keys[k] = el.value.trim();
  }
  return keys;
}

function getServerUrl() {
  return serverUrlInput.value.trim() || "https://captcha-solve.vercel.app";
}

// ---- Save ----
saveBtn.addEventListener("click", () => {
  const keys = getKeys();
  chrome.storage.local.set({
    autoSolve: autoSolve.checked, engine: engineSelect.value,
    serverUrl: getServerUrl(), keys,
  }, () => {
    savedMsg.classList.add("show");
    setTimeout(() => savedMsg.classList.remove("show"), 2000);
    log(`Saved ${Object.keys(keys).length} key(s)`, "ok");
    checkServer();
  });
});

// ---- Load ----
function loadSettings() {
  chrome.storage.local.get(["autoSolve", "engine", "serverUrl", "keys"], (data) => {
    if (data.autoSolve !== undefined) autoSolve.checked = data.autoSolve;
    if (data.engine) engineSelect.value = data.engine;
    if (data.serverUrl) serverUrlInput.value = data.serverUrl;
    if (data.keys) {
      for (const [k, v] of Object.entries(data.keys)) {
        const el = document.getElementById(keyIds[k]);
        if (el) el.value = v;
      }
    }
    const keys = getKeys();
    if (Object.keys(keys).length > 0) chrome.storage.local.set({ keys });
    setTimeout(checkServer, 500);
  });
}
loadSettings();

autoSolve.addEventListener("change", () => chrome.storage.local.set({ autoSolve: autoSolve.checked }));
engineSelect.addEventListener("change", () => chrome.storage.local.set({ engine: engineSelect.value }));

// ---- Server check ----
async function checkServer() {
  const keys = getKeys();
  try {
    const resp = await fetch(`${getServerUrl()}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_keys: keys }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await resp.json();
    if (data.ok) {
      statusDot.classList.add("ok");
      const parts = [];
      if (data.ai_providers && data.ai_providers.length) parts.push(data.ai_providers.join("+"));
      if (data.twocaptcha_available) parts.push("2Captcha");
      statusText.textContent = parts.length ? `Server OK (${parts.join(" + ")})` : "Server OK";
      log("Server connected", "ok");
    }
  } catch (e) {
    statusDot.classList.remove("ok");
    statusText.textContent = "Server offline";
  }
}

// ---- API call ----
async function apiCall(path, body) {
  const keys = getKeys();
  body.api_keys = keys;
  const resp = await fetch(`${getServerUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await resp.json();
  if (json.error) throw new Error(json.error);
  return json;
}

// ---- Capture screenshot ----
function captureTab() {
  return new Promise((resolve) => {
    chrome.tabs.captureVisibleTab(null, { format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError || !dataUrl) resolve(null);
      else resolve(dataUrl.split(",")[1]);
    });
  });
}

// ---- Solve button → popup does EVERYTHING ----
solveBtn.addEventListener("click", async () => {
  solveBtn.disabled = true;
  solveBtn.textContent = "Solving...";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const isHcaptcha = tab.url && tab.url.includes("hcaptcha");

    // 1. Capture screenshot
    log("Capturing screenshot...");
    const screenshot = await captureTab();
    if (!screenshot) { log("Screenshot failed", "err"); return; }

    // 2. Send to AI
    const prompt = isHcaptcha
      ? `This is a drag-and-drop hCaptcha challenge. "Drag ONE character to the matching character behind the lines."
RIGHT side: animals with "Move" buttons (sources, 1-indexed top to bottom).
LEFT side: animals behind fence (targets).
Return ONLY JSON: {"source": 0, "target_x": 150, "target_y": 200}
source: 0-based index of Move button (0=top). target_x/y: pixel position of matching animal on LEFT.
If cannot determine: {"skip": true}`
      : `This is a reCAPTCHA image challenge. "Select all squares with [object]".
Grid 3x3 or 4x4. Numbered 1-9 or 1-16, left-to-right, top-to-bottom.
Return ONLY numbers of matching squares, comma-separated. Example: 1,3,7. If none: 0`;

    log("Sending to AI...");
    const result = await apiCall("/solve/image", { image_base64: screenshot, prompt });
    if (!result.answer) { log("AI returned nothing", "err"); return; }
    log(`AI: ${result.answer}`, "ok");

    // 3. Parse and execute
    if (isHcaptcha) {
      // Parse JSON drag solution
      let solution;
      try {
        const j = result.answer.match(/\{[\s\S]*?\}/);
        if (j) solution = JSON.parse(j[0]);
      } catch (_) {}

      if (!solution || solution.skip) {
        log("AI couldn't solve drag challenge", "err");
        return;
      }

      log(`Drag: source ${solution.source} → (${solution.target_x}, ${solution.target_y})`);

      // Inject drag into ALL frames
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: (sol) => {
          // Find Move buttons
          const allEls = document.querySelectorAll('*');
          const moveBtns = [];
          allEls.forEach(el => {
            if (el.textContent && el.textContent.trim() === 'Move' && el.offsetParent !== null) {
              moveBtns.push(el);
            }
          });
          if (moveBtns.length === 0) return false;

          const src = moveBtns[Math.min(sol.source, moveBtns.length - 1)];
          if (!src) return false;
          const r = src.getBoundingClientRect();
          const sx = r.left + r.width / 2, sy = r.top + r.height / 2;
          const tx = sol.target_x, ty = sol.target_y;

          src.dispatchEvent(new MouseEvent('mousedown', { clientX: sx, clientY: sy, bubbles: true }));
          for (let i = 1; i <= 25; i++) {
            const t = i / 25;
            const e = t < 0.5 ? 2*t*t : 1 - Math.pow(-2*t+2,2)/2;
            document.dispatchEvent(new MouseEvent('mousemove', {
              clientX: sx+(tx-sx)*e, clientY: sy+(ty-sy)*e+(Math.random()-0.5)*1.5, bubbles: true
            }));
          }
          document.dispatchEvent(new MouseEvent('mouseup', { clientX: tx, clientY: ty, bubbles: true }));
          return true;
        },
        args: [solution],
      });
      log("Drag injected!", "ok");

    } else {
      // Parse grid tile numbers
      const nums = result.answer.match(/\d+/g);
      if (!nums || nums.length === 0 || (nums.length === 1 && nums[0] === "0")) {
        log("No matching tiles found", "err");
        return;
      }
      const indices = nums.map(n => parseInt(n) - 1);
      log(`Clicking tiles: [${indices.join(", ")}]`);

      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: (tileIndices) => {
          const tiles = document.querySelectorAll('td[role="button"], .rc-imageselect-tile, table td');
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
      log("Grid tiles clicked!", "ok");
    }

  } catch (e) {
    log(`Error: ${e.message}`, "err");
  } finally {
    solveBtn.disabled = false;
    solveBtn.textContent = "Solve CAPTCHA on This Page";
  }
});

setInterval(checkServer, 30000);
