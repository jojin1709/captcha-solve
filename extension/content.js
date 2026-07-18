/**
 * Captcha Solver - Content Script
 * Detects captchas and solves them via server. Handles CSP and context issues.
 */
(() => {
  "use strict";

  // Prevent multiple runs
  if (window.__captchaSolverRunning) return;
  window.__captchaSolverRunning = true;

  let settings = { autoSolve: true, engine: "auto" };
  let solving = false; // prevent concurrent solves
  let lastSolveTime = 0;
  const COOLDOWN = 15000; // 15s between auto-solves

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
      if (solving) return sendResponse({ error: "Already solving..." });
      detectAndSolve().then(sendResponse).catch((e) => sendResponse({ error: e.message }));
      return true;
    }
  });

  // ---- Utilities ----
  function getKeys() {
    return new Promise((r) => {
      try {
        chrome.storage.local.get(["keys"], (d) => r(d.keys || {}));
      } catch (_) { r({}); }
    });
  }

  async function apiCall(path, body) {
    const keys = await getKeys();
    body.api_keys = keys;
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: "API_REQUEST", path, body }, (resp) => {
          if (chrome.runtime.lastError) {
            reject(new Error("Extension context invalidated. Reload extension."));
            return;
          }
          if (resp && resp.error) reject(new Error(resp.error));
          else resolve(resp);
        });
      } catch (e) {
        reject(new Error("Cannot connect to extension. Reload the page."));
      }
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (msg) => console.log(`[CaptchaSolver] ${msg}`);

  function notify(text, ok = true) {
    try {
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
    } catch (_) {}
  }

  // ---- CSP-safe click ----
  async function safeClick(el) {
    try {
      el.focus();
      await sleep(100);
      el.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", keyCode: 32, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key: " ", code: "Space", keyCode: 32, bubbles: true }));
    } catch (_) {}
    try {
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    } catch (_) {}
  }

  // ---- Find captchas ----
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
    document.querySelectorAll(".g-recaptcha, [data-sitekey]").forEach((el) => {
      if (!found.some((f) => f.el === el)) found.push({ type: "recaptcha", el });
    });
    return found;
  }

  // ---- reCAPTCHA v2 ----
  async function solveReCaptcha() {
    log("Solving reCAPTCHA v2...");

    const anchor = document.querySelector('iframe[src*="recaptcha"][src*="anchor"], iframe[title*="reCAPTCHA"]');
    if (!anchor) { log("No reCAPTCHA frame"); return null; }

    let sitekey = "";
    const m = (anchor.src || "").match(/k=([A-Za-z0-9_-]+)/);
    if (m) sitekey = m[1];
    if (!sitekey) {
      const p = anchor.closest("[data-sitekey]");
      if (p) sitekey = p.getAttribute("data-sitekey") || "";
    }
    log(`Sitekey: ${sitekey.substring(0, 20)}...`);

    // Click checkbox
    await safeClick(anchor);
    log("Clicked checkbox, waiting...");
    await sleep(3000);

    // Check if solved
    const ta = document.querySelector('textarea[name="g-recaptcha-response"]');
    if (ta && ta.value && ta.value.length > 10) {
      log("Already solved!");
      notify("reCAPTCHA solved!");
      autoSubmit();
      return { answer: ta.value, engine: "browser" };
    }

    // Check for challenge
    const challenge = document.querySelector('iframe[src*="bframe"], iframe[title*="challenge"]');
    if (!challenge) {
      if (ta && ta.value) {
        notify("reCAPTCHA solved!");
        autoSubmit();
        return { answer: ta.value, engine: "browser" };
      }
      log("No challenge and no token yet");
      return null;
    }

    log("Challenge appeared, sending to AI...");

    try {
      const result = await apiCall("/solve/recaptcha", {
        sitekey, url: location.href, version: "v2",
      });
      if (result.answer) {
        if (ta) {
          ta.value = result.answer;
          ta.dispatchEvent(new Event("input", { bubbles: true }));
        }
        tryFireCallback("recaptcha", result.answer);
        notify("reCAPTCHA solved!");
        autoSubmit();
        return result;
      }
    } catch (e) {
      log(`Failed: ${e.message}`);
      if (e.message.includes("context")) {
        notify("Extension error — reload page", false);
      }
    }
    return null;
  }

  // ---- hCaptcha ----
  async function solveHCaptcha() {
    log("Solving hCaptcha...");
    const frame = document.querySelector('iframe[src*="hcaptcha"]');
    if (!frame) return null;

    let sitekey = "";
    const m = (frame.src || "").match(/sitekey=([A-Za-z0-9_-]+)/);
    if (m) sitekey = m[1];

    // Click checkbox to start
    await safeClick(frame);
    await sleep(3000);

    // Check if already solved
    const ta = document.querySelector('textarea[name="h-captcha-response"]');
    if (ta && ta.value && ta.value.length > 10) {
      notify("hCaptcha solved!");
      autoSubmit();
      return { answer: ta.value, engine: "browser" };
    }

    // Check for challenge iframe
    const challengeFrame = document.querySelector('iframe[src*="hcaptcha"][src*="challenge"]');
    if (challengeFrame) {
      log("hCaptcha challenge detected, using AI screenshot...");
      return await solveHCaptchaDragChallenge(frame, challengeFrame);
    }

    // Try API-based solve
    try {
      const result = await apiCall("/solve/hcaptcha", { sitekey, url: location.href });
      if (result.answer) {
        if (ta) { ta.value = result.answer; ta.dispatchEvent(new Event("input", { bubbles: true })); }
        tryFireCallback("hcaptcha", result.answer);
        notify("hCaptcha solved!");
        autoSubmit();
        return result;
      }
    } catch (e) { log(`hCaptcha failed: ${e.message}`); }
    return null;
  }

  // ---- hCaptcha Drag Challenge Solver (AI-powered) ----
  async function solveHCaptchaDragChallenge(checkboxFrame, challengeFrame) {
    try {
      // Capture screenshot via background
      log("Capturing screenshot...");
      const screenshot = await captureVisibleTab();
      if (!screenshot) {
        log("Could not capture screenshot, trying API solve...");
        return null;
      }

      log("Screenshot captured, sending to AI...");

      // Send to AI for analysis
      const result = await apiCall("/solve/hcaptcha-drag", {
        screenshot_base64: screenshot,
      });

      if (result.answer) {
        log(`AI response: ${result.answer}`);

        let solution;
        try {
          const jsonMatch = result.answer.match(/\{[\s\S]*?\}/);
          if (jsonMatch) solution = JSON.parse(jsonMatch[0]);
        } catch (e) {
          log(`Parse error: ${e.message}`);
        }

        if (solution && solution.skip) {
          log("AI says skip");
          await clickSkipInFrame(challengeFrame);
          await sleep(2000);
          return { answer: "skipped", engine: "ai" };
        }

        if (solution && solution.source_index !== undefined) {
          log(`Drag animal ${solution.source_index} to (${solution.target_x}, ${solution.target_y})`);
          await performDragInHcaptchaFrame(challengeFrame, solution);
          await sleep(2000);

          // Check result
          const ta = document.querySelector('textarea[name="h-captcha-response"]');
          if (ta && ta.value && ta.value.length > 10) {
            notify("hCaptcha solved!");
            autoSubmit();
            return { answer: ta.value, engine: "ai" };
          }
          log("Drag completed but not solved yet, may need retry");
        }
      }
    } catch (e) {
      log(`hCaptcha drag failed: ${e.message}`);
    }
    return null;
  }

  // Capture visible tab via background script
  function captureVisibleTab() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "CAPTURE_TAB" }, (resp) => {
          if (chrome.runtime.lastError) {
            resolve(null);
          } else if (resp && resp.base64) {
            resolve(resp.base64);
          } else {
            resolve(null);
          }
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  async function performDragInHcaptchaFrame(frame, solution) {
    try {
      const rect = frame.getBoundingClientRect();
      // hCaptcha challenge is typically at a known position
      // Source animals are on the left side (~50px from left)
      const sourceX = rect.left + 60;
      const sourceY = rect.top + 80 + (solution.source_index * 100); // approximate spacing

      // Target is on the right side
      const targetX = rect.left + (solution.target_x || 250);
      const targetY = rect.top + (solution.target_y || 150);

      log(`Drag from (${sourceX}, ${sourceY}) to (${targetX}, ${targetY})`);

      // Perform drag
      const el = document.elementFromPoint(sourceX, sourceY);
      if (el) {
        el.dispatchEvent(new MouseEvent("mousedown", { clientX: sourceX, clientY: sourceY, bubbles: true }));
        await sleep(100);

        // Move in steps for realism
        const steps = 10;
        for (let i = 1; i <= steps; i++) {
          const x = sourceX + (targetX - sourceX) * (i / steps);
          const y = sourceY + (targetY - sourceY) * (i / steps);
          document.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y, bubbles: true }));
          await sleep(30);
        }

        document.dispatchEvent(new MouseEvent("mouseup", { clientX: targetX, clientY: targetY, bubbles: true }));
        log("Drag completed");
      }
    } catch (e) {
      log(`Drag failed: ${e.message}`);
    }
  }

  async function clickSkipInFrame(frame) {
    try {
      const rect = frame.getBoundingClientRect();
      // Skip button is usually at bottom right
      const skipX = rect.left + rect.width - 60;
      const skipY = rect.bottom - 20;
      const el = document.elementFromPoint(skipX, skipY);
      if (el) {
        el.dispatchEvent(new MouseEvent("mousedown", { clientX: skipX, clientY: skipY, bubbles: true }));
        el.dispatchEvent(new MouseEvent("mouseup", { clientX: skipX, clientY: skipY, bubbles: true }));
        el.dispatchEvent(new MouseEvent("click", { clientX: skipX, clientY: skipY, bubbles: true }));
      }
    } catch (e) {}
  }

  // ---- Turnstile ----
  async function solveTurnstile() {
    log("Solving Turnstile...");
    const frame = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
    if (!frame) return null;

    let sitekey = "";
    const m = (frame.src || "").match(/sitekey=([A-Za-z0-9_-]+)/);
    if (m) sitekey = m[1];

    await safeClick(frame);
    await sleep(4000);

    const input = document.querySelector('input[name="cf-turnstile-response"]');
    if (input && input.value && input.value.length > 10) {
      notify("Turnstile solved!");
      return { answer: input.value, engine: "browser" };
    }

    try {
      const result = await apiCall("/solve/turnstile", { sitekey, url: location.href });
      if (result.answer) {
        if (input) { input.value = result.answer; input.dispatchEvent(new Event("input", { bubbles: true })); }
        notify("Turnstile solved!");
        return result;
      }
    } catch (e) { log(`Turnstile failed: ${e.message}`); }
    return null;
  }

  // ---- Image captcha ----
  async function solveImageCaptcha() {
    const imgs = document.querySelectorAll('img[src*="captcha" i], img[alt*="captcha" i]');
    for (const img of imgs) {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        canvas.getContext("2d").drawImage(img, 0, 0);
        const b64 = canvas.toDataURL("image/png").split(",")[1];

        const result = await apiCall("/solve/image", {
          image_base64: b64,
          prompt: "Read the text in this captcha. Return ONLY the text.",
        });
        if (result.answer) {
          const container = img.closest("form") || img.parentElement;
          const input = container ? container.querySelector('input[type="text"], input:not([type])') : null;
          if (input) {
            input.value = result.answer;
            input.dispatchEvent(new Event("input", { bubbles: true }));
          }
          notify(`Solved: ${result.answer}`);
          return result;
        }
      } catch (e) { log(`Image failed: ${e.message}`); }
    }
    return null;
  }

  // ---- Auto-submit after captcha solved ----
  function autoSubmit() {
    setTimeout(() => {
      // Try clicking submit button
      const btns = document.querySelectorAll(
        'button[type="submit"], input[type="submit"], button:not([type="button"])'
      );
      for (const btn of btns) {
        const text = (btn.textContent || btn.value || "").toLowerCase();
        if (text.includes("submit") || text.includes("get result") || text.includes("verify") ||
            text.includes("login") || text.includes("search") || text.includes("check")) {
          log(`Auto-clicking: ${text}`);
          safeClick(btn);
          return;
        }
      }
      // Try submitting the form directly
      const form = document.querySelector("form");
      if (form) {
        log("Auto-submitting form");
        form.submit();
      }
    }, 2000); // Wait 2s after solve for token to propagate
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
    } catch (e) {}
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
    if (solving) return { error: "Already solving" };
    if (Date.now() - lastSolveTime < COOLDOWN) return { error: "Cooldown active" };

    solving = true;
    try {
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
    } finally {
      solving = false;
      lastSolveTime = Date.now();
    }
  }

  // Auto-detect (with cooldown)
  function autoDetect() {
    if (!settings.autoSolve || solving) return;
    if (Date.now() - lastSolveTime < COOLDOWN) return;
    if (findCaptchas().length > 0) {
      log("Auto-detected captcha");
      detectAndSolve().catch(console.error);
    }
  }

  setTimeout(autoDetect, 3000);
  new MutationObserver(() => setTimeout(autoDetect, 2000))
    .observe(document.body, { childList: true, subtree: true });
})();
