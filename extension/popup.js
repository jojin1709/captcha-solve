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

const keyInputs = {
  openai: document.getElementById("keyOpenai"),
  xai: document.getElementById("keyXai"),
  groq: document.getElementById("keyGroq"),
  openrouter: document.getElementById("keyOpenrouter"),
  gemini: document.getElementById("keyGemini"),
  twocaptcha: document.getElementById("keyTwocaptcha"),
};
const serverUrlInput = document.getElementById("serverUrl");

function log(msg, cls = "") {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logDiv.prepend(line);
}

// ---- Load saved settings ----
function loadSettings() {
  chrome.storage.local.get(
    ["autoSolve", "engine", "serverUrl", "keys"],
    (data) => {
      if (data.autoSolve !== undefined) autoSolve.checked = data.autoSolve;
      if (data.engine) engineSelect.value = data.engine;
      if (data.serverUrl) serverUrlInput.value = data.serverUrl;
      if (data.keys) {
        for (const [k, v] of Object.entries(data.keys)) {
          if (keyInputs[k]) keyInputs[k].value = v;
        }
      }
    }
  );
}
loadSettings();

// ---- Save settings ----
saveBtn.addEventListener("click", () => {
  const keys = {};
  for (const [k, input] of Object.entries(keyInputs)) {
    if (input.value.trim()) keys[k] = input.value.trim();
  }
  chrome.storage.local.set(
    {
      autoSolve: autoSolve.checked,
      engine: engineSelect.value,
      serverUrl: serverUrlInput.value.trim(),
      keys,
    },
    () => {
      savedMsg.classList.add("show");
      setTimeout(() => savedMsg.classList.remove("show"), 2000);
      log("Settings saved", "ok");
    }
  );
});

// ---- Settings change listeners ----
autoSolve.addEventListener("change", () => {
  chrome.storage.local.set({ autoSolve: autoSolve.checked });
  sendToContentScript({ type: "UPDATE_SETTINGS", autoSolve: autoSolve.checked, engine: engineSelect.value });
});
engineSelect.addEventListener("change", () => {
  chrome.storage.local.set({ engine: engineSelect.value });
  sendToContentScript({ type: "UPDATE_SETTINGS", autoSolve: autoSolve.checked, engine: engineSelect.value });
});

function sendToContentScript(msg) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, msg);
  });
}

// ---- Server communication ----
function getServerUrl() {
  return serverUrlInput.value.trim() || "http://127.0.0.1:5555";
}

function getKeys() {
  const keys = {};
  for (const [k, input] of Object.entries(keyInputs)) {
    if (input.value.trim()) keys[k] = input.value.trim();
  }
  return keys;
}

async function checkServer() {
  try {
    const resp = await fetch(`${getServerUrl()}/status`, { signal: AbortSignal.timeout(3000) });
    const data = await resp.json();
    if (data.ok) {
      statusDot.classList.add("ok");
      const parts = [];
      if (data.ai_providers && data.ai_providers.length) parts.push(data.ai_providers.join("+"));
      if (data.twocaptcha_available) parts.push("2Captcha");
      statusText.textContent = parts.length ? `Server OK (${parts.join(" + ")})` : "Server OK (no engines)";
      log("Server connected", "ok");
    }
  } catch (e) {
    statusDot.classList.remove("ok");
    statusText.textContent = "Server offline - set URL in Settings";
    log("Server offline", "err");
  }
}

// ---- Manual solve ----
solveBtn.addEventListener("click", async () => {
  solveBtn.disabled = true;
  solveBtn.textContent = "Solving...";
  log("Solving...");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const response = await chrome.tabs.sendMessage(tab.id, { type: "SOLVE_NOW" });
    if (response && response.answer) {
      log(`Solved: ${response.answer.substring(0, 100)}`, "ok");
    } else if (response && response.error) {
      log(`Error: ${response.error}`, "err");
    }
  } catch (e) {
    log(`Error: ${e.message}`, "err");
  } finally {
    solveBtn.disabled = false;
    solveBtn.textContent = "Solve CAPTCHA on This Page";
  }
});

checkServer();
setInterval(checkServer, 15000);
