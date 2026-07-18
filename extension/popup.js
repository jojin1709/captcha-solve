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
    // Auto-sync keys to storage
    const keys = getKeys();
    if (Object.keys(keys).length > 0) {
      chrome.storage.local.set({ keys });
    }
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
  log(`Calling ${path} with ${Object.keys(keys).length} key(s)...`);
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

// ---- Get current tab ----
async function getTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ---- Solve button ----
solveBtn.addEventListener("click", async () => {
  solveBtn.disabled = true;
  solveBtn.textContent = "Solving...";

  try {
    const tab = await getTab();
    log("Capturing screenshot...");
    const screenshot = await captureTab();
    if (!screenshot) { log("Screenshot failed", "err"); return; }

    log("Sending to AI...");
    const result = await apiCall("/solve/image", {
      image_base64: screenshot,
      prompt: `This is a reCAPTCHA image challenge. The instruction says: "Select all squares with [object]".
The grid is 4x4 or 3x3. Numbered left-to-right, top-to-bottom starting from 1.
Return ONLY the numbers of squares containing the target object, separated by commas.
Example: 1,3,7
If none match, return: 0`,
    });

    if (result.answer) {
      log(`AI says: ${result.answer}`, "ok");

      const nums = result.answer.match(/\d+/g);
      if (nums && nums.length > 0 && !(nums.length === 1 && nums[0] === "0")) {
        const indices = nums.map(n => parseInt(n) - 1);
        log(`Clicking tiles: ${indices.join(", ")}`);

        // Inject click script into ALL frames on the page
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          allFrames: true,
          func: (tileIndices) => {
            // Find reCAPTCHA tile elements
            const tiles = document.querySelectorAll(
              'td[role="button"], .rc-imageselect-tile, table.rc-imageselect-table-33 td, table.rc-imageselect-table-44 td, .rc-imageselect-checkbox'
            );
            if (tiles.length === 0) return false;

            tileIndices.forEach(i => {
              if (tiles[i]) {
                tiles[i].click();
              }
            });

            // Click verify after a delay
            setTimeout(() => {
              const verify = document.querySelector('#recaptcha-verify-button, .rc-button-default');
              if (verify) verify.click();
            }, 1500);
            return true;
          },
          args: [indices],
        });
        log("Clicked tiles and verify!", "ok");
      } else {
        log("AI found no matching tiles", "err");
      }
    }
  } catch (e) {
    log(`Error: ${e.message}`, "err");
  } finally {
    solveBtn.disabled = false;
    solveBtn.textContent = "Solve CAPTCHA on This Page";
  }
});

setInterval(checkServer, 30000);
