// ---- Tab switching ----
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(`panel-${tab.dataset.tab}`).classList.add("active");
  });
});

// ---- Elements ----
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
  openai: "keyOpenai",
  xai: "keyXai",
  groq: "keyGroq",
  openrouter: "keyOpenrouter",
  gemini: "keyGemini",
  twocaptcha: "keyTwocaptcha",
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

// ---- Save settings ----
saveBtn.addEventListener("click", () => {
  const keys = getKeys();
  const data = {
    autoSolve: autoSolve.checked,
    engine: engineSelect.value,
    serverUrl: getServerUrl(),
    keys: keys,
  };
  chrome.storage.local.set(data, () => {
    savedMsg.classList.add("show");
    setTimeout(() => savedMsg.classList.remove("show"), 2000);
    log(`Saved ${Object.keys(keys).length} key(s)`, "ok");
    // Recheck server with new keys
    checkServer();
  });
});

// ---- Load settings ----
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
    // Auto-save keys from inputs to storage (fixes empty storage issue)
    const keys = getKeys();
    if (Object.keys(keys).length > 0) {
      chrome.storage.local.set({ keys }, () => {
        log("Keys synced to storage", "ok");
      });
    }
    setTimeout(checkServer, 500);
  });
}
loadSettings();

// ---- Settings change listeners ----
autoSolve.addEventListener("change", () => {
  chrome.storage.local.set({ autoSolve: autoSolve.checked });
  sendToContent({ type: "UPDATE_SETTINGS", autoSolve: autoSolve.checked, engine: engineSelect.value });
});
engineSelect.addEventListener("change", () => {
  chrome.storage.local.set({ engine: engineSelect.value });
  sendToContent({ type: "UPDATE_SETTINGS", autoSolve: autoSolve.checked, engine: engineSelect.value });
});

function sendToContent(msg) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, msg, () => {
        // Ignore errors - content script may not be loaded
        void chrome.runtime.lastError;
      });
    }
  });
}

// ---- Server check ----
async function checkServer() {
  const serverUrl = getServerUrl();
  const keys = getKeys();
  const hasKeys = Object.keys(keys).length > 0;

  try {
    const resp = await fetch(`${serverUrl}/status`, {
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
      if (parts.length) {
        statusText.textContent = `Server OK (${parts.join(" + ")})`;
      } else if (hasKeys) {
        statusText.textContent = "Server OK — keys sent, checking...";
      } else {
        statusText.textContent = "Server OK — add API key in Settings";
      }
      log("Server connected", "ok");
    }
  } catch (e) {
    statusDot.classList.remove("ok");
    statusText.textContent = "Server offline";
    log(`Server error: ${e.message}`, "err");
  }
}

// ---- Manual solve ----
solveBtn.addEventListener("click", async () => {
  solveBtn.disabled = true;
  solveBtn.textContent = "Solving...";
  log("Solving...");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    chrome.tabs.sendMessage(tab.id, { type: "SOLVE_NOW" }, (response) => {
      void chrome.runtime.lastError;
      if (response && response.answer) {
        log(`Solved!`, "ok");
      } else if (response && response.error) {
        log(`Error: ${response.error}`, "err");
      } else {
        log("No response from content script", "err");
      }
      solveBtn.disabled = false;
      solveBtn.textContent = "Solve CAPTCHA on This Page";
    });
  } catch (e) {
    log(`Error: ${e.message}`, "err");
    solveBtn.disabled = false;
    solveBtn.textContent = "Solve CAPTCHA on This Page";
  }
});

setInterval(checkServer, 30000);
