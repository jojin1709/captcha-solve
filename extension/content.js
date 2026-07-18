/**
 * Captcha Solver - Content Script
 * Calls server directly via fetch (no background script dependency).
 */
(() => {
  "use strict";
  if (window.__captchaSolverRunning) return;
  window.__captchaSolverRunning = true;

  let settings = { autoSolve: true, engine: "auto" };
  let solving = false;
  let lastSolveTime = 0;
  const COOLDOWN = 10000;

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
      if (solving) return sendResponse({ error: "Already solving" });
      detectAndSolve().then(sendResponse).catch((e) => sendResponse({ error: e.message }));
      return true;
    }
  });

  // ---- Server call (direct fetch, always fresh keys) ----
  async function apiCall(path, body) {
    const { serverUrl, keys } = await new Promise((resolve) => {
      chrome.storage.local.get(["serverUrl", "keys"], (d) => {
        resolve({
          serverUrl: d.serverUrl || "https://captcha-solve.vercel.app",
          keys: d.keys || {},
        });
      });
    });

    body.api_keys = keys;
    log(`Calling ${path} with ${Object.keys(keys).length} key(s)`);

    const resp = await fetch(`${serverUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await resp.json();
    if (json.error) throw new Error(json.error);
    return json;
  }

  // ---- Screenshot via background (with fallback) ----
  function captureTab() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "CAPTURE_TAB" }, (resp) => {
          if (resp && resp.base64) resolve(resp.base64);
          else resolve(null);
        });
        setTimeout(() => resolve(null), 3000);
      } catch (_) { resolve(null); }
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

  // ---- Auto-submit ----
  function autoSubmit() {
    setTimeout(() => {
      const btns = document.querySelectorAll('button[type="submit"], input[type="submit"], button');
      for (const btn of btns) {
        const t = (btn.textContent || btn.value || "").toLowerCase();
        if (t.includes("submit") || t.includes("get result") || t.includes("verify") || t.includes("login") || t.includes("search")) {
          log(`Auto-clicking: ${t}`);
          safeClick(btn);
          return;
        }
      }
      const form = document.querySelector("form");
      if (form) { log("Auto-submitting form"); form.submit(); }
    }, 2000);
  }

  // ---- reCAPTCHA ----
  async function solveReCaptcha() {
    log("Solving reCAPTCHA v2...");

    const anchor = document.querySelector(
      'iframe[src*="recaptcha"][src*="anchor"], iframe[title*="reCAPTCHA"], iframe[title*="recaptcha"]'
    );
    if (!anchor) { log("No reCAPTCHA anchor"); return null; }

    let sitekey = "";
    const m = (anchor.src || "").match(/k=([A-Za-z0-9_-]+)/);
    if (m) sitekey = m[1];
    log(`Sitekey: ${sitekey.substring(0, 20)}...`);

    // Click checkbox
    await safeClick(anchor);
    log("Clicked checkbox, waiting...");
    await sleep(3000);

    // Check if solved
    const ta = document.querySelector('textarea[name="g-recaptcha-response"]');
    if (ta && ta.value && ta.value.length > 10) {
      notify("reCAPTCHA solved!");
      autoSubmit();
      return { answer: ta.value, engine: "browser" };
    }

    // Wait for challenge iframe
    let challenge = null;
    for (let i = 0; i < 10; i++) {
      challenge = document.querySelector('iframe[src*="bframe"], iframe[title*="challenge"]');
      if (!challenge) {
        document.querySelectorAll('iframe[src*="recaptcha"]').forEach(f => {
          if (f !== anchor && !challenge) challenge = f;
        });
      }
      if (challenge) break;
      await sleep(500);
    }

    if (!challenge) {
      if (ta && ta.value) { notify("reCAPTCHA solved!"); autoSubmit(); return { answer: ta.value, engine: "browser" }; }
      return null;
    }

    log("Challenge found! Getting frame info...");

    // Get the frame ID from background
    const frameInfo = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "GET_FRAMES" }, (resp) => {
          resolve(resp || { frames: [] });
        });
      } catch (_) { resolve({ frames: [] }); }
    });

    // Find the challenge frame ID
    const challengeSrc = challenge.src || "";
    let challengeFrameId = null;
    for (const frame of (frameInfo.frames || [])) {
      if (frame.url && (frame.url.includes("bframe") || frame.url.includes("recaptcha") || frame.url.includes("challenge"))) {
        if (frame.frameId !== undefined) {
          challengeFrameId = frame.frameId;
          break;
        }
      }
    }

    log(`Challenge frame ID: ${challengeFrameId}`);

    // Capture screenshot
    const screenshot = await captureTab();
    if (!screenshot) {
      log("No screenshot, skipping...");
      return null;
    }

    // Ask AI which tiles to click
    log("Sending screenshot to AI...");
    const result = await apiCall("/solve/image", {
      image_base64: screenshot,
      prompt: `This is a reCAPTCHA image challenge. The instruction says: "Select all squares with [object]".
The grid is 4x4 or 3x3. Numbered left-to-right, top-to-bottom starting from 1.
Return ONLY the numbers of squares containing the target object, separated by commas.
Example: 1,3,7
If none match, return: 0`,
    });

    if (!result.answer) {
      log("AI returned no answer");
      return null;
    }

    log(`AI says: ${result.answer}`);

    // Parse numbers
    const nums = result.answer.match(/\d+/g);
    if (!nums || nums.length === 0 || (nums.length === 1 && nums[0] === "0")) {
      log("AI says no matches, skipping...");
      return null;
    }

    const tileIndices = nums.map(n => parseInt(n) - 1);
    log(`Clicking tiles: ${tileIndices.join(", ")}`);

    // Inject script into the challenge frame to click tiles
    if (challengeFrameId !== null) {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          type: "INJECT_RECAPTCHA_SOLVER",
          frameId: challengeFrameId,
          tileIndices: tileIndices,
        }, () => { resolve(); });
      });
      log("Injected click script into challenge frame");
      await sleep(3000);

      // Check result
      const ta2 = document.querySelector('textarea[name="g-recaptcha-response"]');
      if (ta2 && ta2.value && ta2.value.length > 10) {
        notify("reCAPTCHA solved!");
        autoSubmit();
        return { answer: ta2.value, engine: "ai" };
      }
    } else {
      log("Could not find challenge frame ID, trying direct injection...");
      // Try injecting into all recaptcha frames
      try {
        chrome.scripting.executeScript({
          target: { tabId: (await new Promise(r => chrome.tabs.query({active:true,currentWindow:true}, tabs => r(tabs[0].id)))) },
          allFrames: true,
          func: (indices) => {
            if (!document.querySelector('td[role="button"]') && !document.querySelector('.rc-imageselect-tile')) return false;
            const tiles = document.querySelectorAll('td[role="button"], .rc-imageselect-tile, table.rc-imageselect-table-33 td, table.rc-imageselect-table-44 td');
            indices.forEach(i => { if (tiles[i]) tiles[i].click(); });
            setTimeout(() => {
              const btn = document.querySelector('#recaptcha-verify-button');
              if (btn) btn.click();
            }, 1000);
            return true;
          },
          args: [tileIndices],
        });
        log("Injected via allFrames");
      } catch (e) {
        log(`Injection failed: ${e.message}`);
      }
    }

    await sleep(3000);
    const ta3 = document.querySelector('textarea[name="g-recaptcha-response"]');
    if (ta3 && ta3.value && ta3.value.length > 10) {
      notify("reCAPTCHA solved!");
      autoSubmit();
      return { answer: ta3.value, engine: "ai" };
    }

    log("Not solved yet, may need retry");
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

    await safeClick(frame);
    await sleep(3000);

    const ta = document.querySelector('textarea[name="h-captcha-response"]');
    if (ta && ta.value && ta.value.length > 10) {
      notify("hCaptcha solved!");
      autoSubmit();
      return { answer: ta.value, engine: "browser" };
    }

    // Check for challenge (drag puzzle)
    const challengeFrame = document.querySelector('iframe[src*="hcaptcha"][src*="challenge"]');
    if (challengeFrame) {
      log("hCaptcha challenge detected, using AI...");
      return await solveHCaptchaDrag(challengeFrame);
    }

    // Try API solve
    try {
      const result = await apiCall("/solve/hcaptcha", { sitekey, url: location.href });
      if (result.answer) {
        if (ta) { ta.value = result.answer; ta.dispatchEvent(new Event("input", { bubbles: true })); }
        notify("hCaptcha solved!");
        autoSubmit();
        return result;
      }
    } catch (e) { log(`hCaptcha failed: ${e.message}`); }
    return null;
  }

  async function solveHCaptchaDrag(challengeFrame) {
    try {
      const screenshot = await captureTab();
      if (!screenshot) {
        log("No screenshot, clicking Skip...");
        await clickSkip(challengeFrame);
        return { answer: "skipped" };
      }

      log("Sending screenshot to AI...");
      const result = await apiCall("/solve/hcaptcha-drag", { screenshot_base64: screenshot });

      if (result.answer) {
        let solution;
        try {
          const j = result.answer.match(/\{[\s\S]*?\}/);
          if (j) solution = JSON.parse(j[0]);
        } catch (_) {}

        if (solution && solution.skip) {
          await clickSkip(challengeFrame);
          await sleep(1500);
          return { answer: "skipped" };
        }

        if (solution && solution.source_index !== undefined) {
          await performDrag(challengeFrame, solution);
          await sleep(2000);
          const ta = document.querySelector('textarea[name="h-captcha-response"]');
          if (ta && ta.value && ta.value.length > 10) {
            notify("hCaptcha solved!");
            autoSubmit();
            return { answer: ta.value };
          }
        }
      }
    } catch (e) { log(`hCaptcha drag failed: ${e.message}`); }
    await clickSkip(challengeFrame);
    return null;
  }

  async function performDrag(frame, sol) {
    const rect = frame.getBoundingClientRect();
    const srcX = rect.left + 60;
    const srcY = rect.top + 80 + (sol.source_index * 100);
    const tgtX = rect.left + (sol.target_x || 250);
    const tgtY = rect.top + (sol.target_y || 150);

    const el = document.elementFromPoint(srcX, srcY);
    if (!el) return;
    el.dispatchEvent(new MouseEvent("mousedown", { clientX: srcX, clientY: srcY, bubbles: true }));
    await sleep(100);
    for (let i = 1; i <= 10; i++) {
      const x = srcX + (tgtX - srcX) * (i / 10);
      const y = srcY + (tgtY - srcY) * (i / 10);
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y, bubbles: true }));
      await sleep(30);
    }
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: tgtX, clientY: tgtY, bubbles: true }));
  }

  async function clickSkip(frame) {
    try {
      const rect = frame.getBoundingClientRect();
      const x = rect.left + rect.width - 60;
      const y = rect.bottom - 20;
      const el = document.elementFromPoint(x, y);
      if (el) {
        el.dispatchEvent(new MouseEvent("mousedown", { clientX: x, clientY: y, bubbles: true }));
        el.dispatchEvent(new MouseEvent("mouseup", { clientX: x, clientY: y, bubbles: true }));
        el.dispatchEvent(new MouseEvent("click", { clientX: x, clientY: y, bubbles: true }));
      }
    } catch (_) {}
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
      autoSubmit();
      return { answer: input.value, engine: "browser" };
    }

    try {
      const result = await apiCall("/solve/turnstile", { sitekey, url: location.href });
      if (result.answer) {
        if (input) { input.value = result.answer; input.dispatchEvent(new Event("input", { bubbles: true })); }
        notify("Turnstile solved!");
        autoSubmit();
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
        const result = await apiCall("/solve/image", { image_base64: b64, prompt: "Read the captcha text. Return only the text." });
        if (result.answer) {
          const container = img.closest("form") || img.parentElement;
          const input = container ? container.querySelector('input[type="text"], input:not([type])') : null;
          if (input) { input.value = result.answer; input.dispatchEvent(new Event("input", { bubbles: true })); }
          notify(`Solved: ${result.answer}`);
          autoSubmit();
          return result;
        }
      } catch (e) { log(`Image failed: ${e.message}`); }
    }
    return null;
  }

  // ---- Main ----
  async function detectAndSolve() {
    if (!settings.autoSolve) return { error: "Disabled" };
    if (solving) return { error: "Busy" };
    if (Date.now() - lastSolveTime < COOLDOWN) return { error: "Cooldown" };

    solving = true;
    try {
      for (const c of findCaptchas()) {
        log(`Found: ${c.type}`);
        if (c.type === "recaptcha") { const r = await solveReCaptcha(); if (r) return r; }
        if (c.type === "hcaptcha") { const r = await solveHCaptcha(); if (r) return r; }
        if (c.type === "turnstile") { const r = await solveTurnstile(); if (r) return r; }
      }
      const r = await solveImageCaptcha();
      if (r) return r;
      return { error: "No captcha detected" };
    } finally {
      solving = false;
      lastSolveTime = Date.now();
    }
  }

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
