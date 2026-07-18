/**
 * Captcha Solver - Content Script
 * Detects and solves captchas using AI via the local/cloud server.
 * Uses keyboard events to bypass CSP restrictions on protected sites.
 */
(() => {
  "use strict";

  let settings = { autoSolve: true, engine: "auto" };
  chrome.storage.local.get(["autoSolve", "engine"], (d) => {
    if (d.autoSolve !== undefined) settings.autoSolve = d.autoSolve;
    if (d.engine) settings.engine = d.engine;
  });

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg.type === "UPDATE_SETTINGS") {
      settings.autoSolve = msg.autoSolve;
      settings.engine = msg.engine;
      sendResponse({ ok: true });
    }
    if (msg.type === "SOLVE_NOW") {
      detectAndSolve().then(sendResponse).catch((e) => sendResponse({ error: e.message }));
      return true;
    }
  });

  // ---- Utilities ----
  function getServerUrl() {
    return new Promise((r) => chrome.storage.local.get(["serverUrl"], (d) => r(d.serverUrl || "http://127.0.0.1:5555")));
  }
  function getKeys() {
    return new Promise((r) => chrome.storage.local.get(["keys"], (d) => r(d.keys || {})));
  }
  async function apiCall(path, body) {
    const keys = await getKeys();
    body.api_keys = keys;
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "API_REQUEST", path, body }, (resp) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (resp && resp.error) reject(new Error(resp.error));
        else resolve(resp);
      });
    });
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (msg) => console.log(`[CaptchaSolver] ${msg}`);

  function notify(text, ok = true) {
    const d = document.createElement("div");
    d.textContent = `[Captcha Solver] ${text}`;
    Object.assign(d.style, {
      position: "fixed", bottom: "20px", right: "20px", zIndex: "2147483647",
      background: ok ? "#16a34a" : "#dc2626", color: "#fff",
      padding: "12px 18px", borderRadius: "10px", fontSize: "14px",
      boxShadow: "0 4px 16px rgba(0,0,0,0.4)", fontFamily: "sans-serif",
      transition: "opacity 0.5s",
    });
    document.body.appendChild(d);
    setTimeout(() => { d.style.opacity = "0"; setTimeout(() => d.remove(), 600); }, 4000);
  }

  // ---- CSP-safe click using keyboard ----
  async function safeClick(el) {
    // Focus the element first
    el.focus();
    await sleep(100);
    // Dispatch keyboard Space event (bypasses CSP)
    el.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", keyCode: 32, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keypress", { key: " ", code: "Space", keyCode: 32, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { key: " ", code: "Space", keyCode: 32, bubbles: true }));
    // Also try mousedown/mouseup (some sites need this)
    try {
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    } catch (_) {}
  }

  // ---- Find captcha frames ----
  function findCaptchas() {
    const found = [];
    document.querySelectorAll("iframe").forEach((f) => {
      const src = (f.src || "").toLowerCase();
      const title = (f.title || "").toLowerCase();
      if (src.includes("recaptcha") || title.includes("recaptcha") || title.includes("challenge expires")) {
        found.push({ type: "recaptcha", el: f });
      } else if (src.includes("hcaptcha")) {
        found.push({ type: "hcaptcha", el: f });
      } else if (src.includes("challenges.cloudflare")) {
        found.push({ type: "turnstile", el: f });
      }
    });
    document.querySelectorAll(".g-recaptcha, [data-sitekey], .h-captcha").forEach((el) => {
      found.push({ type: "recaptcha", el });
    });
    return found;
  }

  // ---- reCAPTCHA v2 ----
  async function solveReCaptcha() {
    log("Solving reCAPTCHA v2...");

    // Find anchor iframe
    const anchor = document.querySelector('iframe[src*="recaptcha"][src*="anchor"], iframe[title*="reCAPTCHA"]');
    if (!anchor) {
      log("No reCAPTCHA anchor frame");
      return null;
    }

    // Extract sitekey from src or parent
    let sitekey = "";
    const src = anchor.src || "";
    const m = src.match(/k=([A-Za-z0-9_-]+)/);
    if (m) sitekey = m[1];
    if (!sitekey) {
      const parent = anchor.closest("[data-sitekey]");
      if (parent) sitekey = parent.getAttribute("data-sitekey") || "";
    }
    log(`Sitekey: ${sitekey.substring(0, 15)}...`);

    // Click checkbox via keyboard (CSP-safe)
    try {
      await safeClick(anchor);
      log("Clicked reCAPTCHA checkbox");
      await sleep(3000);
    } catch (e) {
      log(`Click failed: ${e.message}`);
    }

    // Check if already solved
    const textarea = document.querySelector('textarea[name="g-recaptcha-response"]');
    if (textarea && textarea.value && textarea.value.length > 10) {
      log("reCAPTCHA already solved");
      notify("reCAPTCHA solved!");
      return { answer: textarea.value, engine: "browser" };
    }

    // Check for challenge frame
    const challenge = document.querySelector(
      'iframe[src*="recaptcha"][src*="bframe"], iframe[title*="challenge"]'
    );
    if (!challenge) {
      log("No challenge frame — checking token...");
      if (textarea && textarea.value) {
        notify("reCAPTCHA solved!");
        return { answer: textarea.value, engine: "browser" };
      }
      return null;
    }

    log("Challenge appeared, sending to AI...");

    // Send to server for solving
    try {
      const result = await apiCall("/solve/recaptcha", {
        sitekey, url: location.href, version: "v2",
      });
      if (result.answer) {
        if (textarea) {
          textarea.value = result.answer;
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
        }
        tryFireCallback("recaptcha", result.answer);
        notify("reCAPTCHA solved!");
        return result;
      }
    } catch (e) {
      log(`reCAPTCHA solve failed: ${e.message}`);
    }
    return null;
  }

  // ---- hCaptcha ----
  async function solveHCaptcha() {
    log("Solving hCaptcha...");
    const frame = document.querySelector('iframe[src*="hcaptcha"][src*="checkbox"], iframe[title*="hCaptcha"]');
    if (!frame) return null;

    let sitekey = "";
    const m = (frame.src || "").match(/sitekey=([A-Za-z0-9_-]+)/);
    if (m) sitekey = m[1];
    if (!sitekey) {
      const div = document.querySelector(".h-captcha, [data-sitekey]");
      if (div) sitekey = div.getAttribute("data-sitekey") || "";
    }

    try {
      await safeClick(frame);
      await sleep(3000);
    } catch (e) { log(`hCaptcha click failed: ${e.message}`); }

    const textarea = document.querySelector('textarea[name="h-captcha-response"]');
    if (textarea && textarea.value && textarea.value.length > 10) {
      notify("hCaptcha solved!");
      return { answer: textarea.value, engine: "browser" };
    }

    const challenge = document.querySelector('iframe[src*="hcaptcha"][src*="challenge"]');
    if (!challenge && textarea && textarea.value) {
      notify("hCaptcha solved!");
      return { answer: textarea.value, engine: "browser" };
    }

    if (challenge) {
      try {
        const result = await apiCall("/solve/hcaptcha", { sitekey, url: location.href });
        if (result.answer) {
          if (textarea) { textarea.value = result.answer; textarea.dispatchEvent(new Event("input", { bubbles: true })); }
          tryFireCallback("hcaptcha", result.answer);
          notify("hCaptcha solved!");
          return result;
        }
      } catch (e) { log(`hCaptcha failed: ${e.message}`); }
    }
    return null;
  }

  // ---- Turnstile ----
  async function solveTurnstile() {
    log("Solving Turnstile...");
    const frame = document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[title*="Cloudflare"]');
    if (!frame) return null;

    let sitekey = "";
    const m = (frame.src || "").match(/sitekey=([A-Za-z0-9_-]+)/);
    if (!sitekey) {
      const div = document.querySelector(".cf-turnstile, [data-sitekey]");
      if (div) sitekey = div.getAttribute("data-sitekey") || "";
    }
    if (m) sitekey = m[1];

    try {
      await safeClick(frame);
      await sleep(4000);
    } catch (e) { log(`Turnstile click failed: ${e.message}`); }

    const input = document.querySelector('input[name="cf-turnstile-response"]');
    if (input && input.value && input.value.length > 10) {
      notify("Turnstile solved!");
      return { answer: input.value, engine: "browser" };
    }

    if (sitekey) {
      try {
        const result = await apiCall("/solve/turnstile", { sitekey, url: location.href });
        if (result.answer) {
          if (input) { input.value = result.answer; input.dispatchEvent(new Event("input", { bubbles: true })); }
          notify("Turnstile solved!");
          return result;
        }
      } catch (e) { log(`Turnstile failed: ${e.message}`); }
    }
    return null;
  }

  // ---- Image captcha ----
  async function solveImageCaptcha() {
    const imgs = document.querySelectorAll(
      'img[src*="captcha" i], img[alt*="captcha" i], img[src*="mtcaptcha"]'
    );
    for (const img of imgs) {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        canvas.getContext("2d").drawImage(img, 0, 0);
        const b64 = canvas.toDataURL("image/png").split(",")[1];

        const result = await apiCall("/solve/image", {
          image_base64: b64,
          prompt: "Read the text in this captcha image. Return ONLY the text characters.",
        });
        if (result.answer) {
          const container = img.closest("form") || img.parentElement;
          const input = container ? container.querySelector('input[type="text"], input:not([type])') : null;
          if (input) {
            input.value = result.answer;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
          }
          notify(`Solved: ${result.answer}`);
          return result;
        }
      } catch (e) { log(`Image captcha failed: ${e.message}`); }
    }
    return null;
  }

  // ---- Callbacks ----
  function tryFireCallback(type, token) {
    try {
      if (type === "recaptcha" && window.___grecaptcha_cfg) {
        const clients = window.___grecaptcha_cfg.clients;
        if (clients) {
          for (const k of Object.keys(clients)) {
            const cb = findCb(clients[k]);
            if (cb && typeof cb === "function") { cb(token); return; }
          }
        }
      }
      if (type === "hcaptcha" && window.hcaptcha) window.hcaptcha.execute();
    } catch (e) { log(`Callback failed: ${e.message}`); }
  }

  function findCb(obj, d = 0) {
    if (d > 8 || !obj) return null;
    if (typeof obj === "function") return obj;
    if (typeof obj === "object") {
      for (const k of Object.keys(obj)) {
        if (k.toLowerCase().includes("callback")) return obj[k];
        const f = findCb(obj[k], d + 1);
        if (f && typeof f === "function") return f;
      }
    }
    return null;
  }

  // ---- Main ----
  async function detectAndSolve() {
    if (!settings.autoSolve) return { error: "Auto-solve disabled" };

    const captchas = findCaptchas();
    log(`Found ${captchas.length} captcha(s)`);

    for (const c of captchas) {
      if (c.type === "recaptcha") {
        const r = await solveReCaptcha();
        if (r) return r;
      }
      if (c.type === "hcaptcha") {
        const r = await solveHCaptcha();
        if (r) return r;
      }
      if (c.type === "turnstile") {
        const r = await solveTurnstile();
        if (r) return r;
      }
    }

    const r3 = await solveImageCaptcha();
    if (r3) return r3;

    return { error: "No captcha detected" };
  }

  // Auto-detect
  function autoDetect() {
    if (!settings.autoSolve) return;
    if (findCaptchas().length > 0) {
      log("Auto-detected captcha, solving...");
      detectAndSolve().catch(console.error);
    }
  }

  setTimeout(autoDetect, 2000);
  new MutationObserver(() => setTimeout(autoDetect, 1500))
    .observe(document.body, { childList: true, subtree: true });
})();
