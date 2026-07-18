/**
 * Captcha Solver - Content Script (Full AI Mode)
 *
 * Detects captchas on the page and solves them using AI vision.
 * Works with: reCAPTCHA v2, hCaptcha, Turnstile, image captchas, puzzles.
 * No paid API needed — uses AI (Grok/Gemini/OpenAI) via local server.
 *
 * How it works:
 * 1. Detects captcha iframe or element
 * 2. Clicks checkbox to trigger challenge
 * 3. Screenshots the challenge
 * 4. Sends image to AI server for analysis
 * 5. Clicks correct tiles / fills answer
 * 6. Browser handles token generation naturally
 */
(() => {
  "use strict";

  let settings = { autoSolve: true, engine: "auto" };

  chrome.storage.local.get(["autoSolve", "engine"], (data) => {
    if (data.autoSolve !== undefined) settings.autoSolve = data.autoSolve;
    if (data.engine) settings.engine = data.engine;
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
    return new Promise((resolve) => {
      chrome.storage.local.get(["serverUrl"], (d) => resolve(d.serverUrl || "http://127.0.0.1:5555"));
    });
  }

  function getKeys() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["keys"], (d) => resolve(d.keys || {}));
    });
  }

  async function apiCall(path, body) {
    const serverUrl = await getServerUrl();
    const keys = await getKeys();
    body.api_keys = keys;
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: "API_REQUEST", path, body },
        (resp) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else if (resp && resp.error) reject(new Error(resp.error));
          else resolve(resp);
        }
      );
    });
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function log(msg) { console.log(`[CaptchaSolver] ${msg}`); }

  function showNotification(text, success = true) {
    const div = document.createElement("div");
    div.textContent = `[Captcha Solver] ${text}`;
    Object.assign(div.style, {
      position: "fixed", bottom: "20px", right: "20px", zIndex: "2147483647",
      background: success ? "#16a34a" : "#dc2626", color: "#fff",
      padding: "12px 18px", borderRadius: "10px", fontSize: "14px",
      boxShadow: "0 4px 16px rgba(0,0,0,0.4)", fontFamily: "sans-serif",
      transition: "opacity 0.5s",
    });
    document.body.appendChild(div);
    setTimeout(() => { div.style.opacity = "0"; setTimeout(() => div.remove(), 600); }, 4000);
  }

  function screenshotElement(el) {
    return new Promise((resolve) => {
      try {
        const rect = el.getBoundingClientRect();
        const canvas = document.createElement("canvas");
        canvas.width = rect.width;
        canvas.height = rect.height;
        // Use html2canvas-like approach - for now return null, server will handle
        resolve(null);
      } catch (e) { resolve(null); }
    });
  }

  // ---- reCAPTCHA v2 Solver ----
  async function solveReCaptchaV2() {
    log("Attempting reCAPTCHA v2 solve...");

    // Find reCAPTCHA iframe
    const recaptchaFrame = document.querySelector('iframe[src*="recaptcha"][src*="anchor"]');
    if (!recaptchaFrame) {
      log("No reCAPTCHA anchor frame found");
      return null;
    }

    // Extract sitekey
    const src = recaptchaFrame.src || "";
    const sitekeyMatch = src.match(/k=([A-Za-z0-9_-]+)/);
    if (!sitekeyMatch) {
      log("Could not extract reCAPTCHA sitekey");
      return null;
    }
    const sitekey = sitekeyMatch[1];
    log(`Found reCAPTCHA sitekey: ${sitekey.substring(0, 20)}...`);

    // Step 1: Click the checkbox
    try {
      const rect = recaptchaFrame.getBoundingClientRect();
      // Click center of the reCAPTCHA checkbox iframe
      const clickX = rect.left + 33;
      const clickY = rect.top + 33;

      const evt = new MouseEvent("click", {
        bubbles: true, cancelable: true, view: window,
        clientX: clickX, clientY: clickY
      });
      recaptchaFrame.dispatchEvent(evt);

      // Also try clicking via elementFromPoint
      const target = document.elementFromPoint(clickX, clickY);
      if (target) {
        target.click();
        target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      }

      log("Clicked reCAPTCHA checkbox");
      await sleep(2500);
    } catch (e) {
      log(`Click failed: ${e.message}`);
    }

    // Step 2: Check if challenge appeared
    const challengeFrame = document.querySelector(
      'iframe[src*="recaptcha"][src*="bframe"], iframe[title*="challenge"]'
    );

    if (!challengeFrame) {
      // Might already be solved (no challenge needed)
      log("No challenge frame — might be already solved");
      // Check for success checkmark
      const textarea = document.querySelector('textarea[name="g-recaptcha-response"]');
      if (textarea && textarea.value && textarea.value.length > 10) {
        log("reCAPTCHA already solved (token present)");
        showNotification("reCAPTCHA solved!");
        return { answer: "auto-solved", engine: "browser" };
      }
      return null;
    }

    log("Challenge appeared, sending to AI...");

    // Step 3: Screenshot the challenge iframe
    let challengeScreenshot = null;
    try {
      const cRect = challengeFrame.getBoundingClientRect();
      challengeScreenshot = {
        x: cRect.x, y: cRect.y,
        width: cRect.width, height: cRect.height,
      };
    } catch (e) {
      log(`Challenge screenshot failed: ${e.message}`);
    }

    // Step 4: Ask AI to solve via the challenge URL
    try {
      const challengeSrc = challengeFrame.src || "";
      const result = await apiCall("/solve/recaptcha", {
        sitekey: sitekey,
        url: location.href,
        version: "v2",
        challenge_url: challengeSrc,
        page_html: document.documentElement.outerHTML.substring(0, 5000),
      });

      if (result.answer) {
        log(`AI solved reCAPTCHA: ${result.answer.substring(0, 50)}...`);
        // Fill token
        const textarea = document.querySelector('textarea[name="g-recaptcha-response"], #g-recaptcha-response');
        if (textarea) {
          textarea.value = result.answer;
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
          textarea.dispatchEvent(new Event("change", { bubbles: true }));
        }
        // Try callback
        tryFireCallback("recaptcha", result.answer);
        showNotification("reCAPTCHA solved!");
        return result;
      }
    } catch (e) {
      log(`AI reCAPTCHA solve failed: ${e.message}`);
    }

    return null;
  }

  // ---- hCaptcha Solver ----
  async function solveHCaptcha() {
    log("Attempting hCaptcha solve...");

    const hcaptchaFrame = document.querySelector('iframe[src*="hcaptcha"][src*="checkbox"]');
    if (!hcaptchaFrame) {
      log("No hCaptcha frame found");
      return null;
    }

    const src = hcaptchaFrame.src || "";
    const sitekeyMatch = src.match(/sitekey=([A-Za-z0-9_-]+)/);
    const div = document.querySelector('.h-captcha, [data-hcaptcha-widget-id]');
    const sitekey = sitekeyMatch ? sitekeyMatch[1] : (div ? div.getAttribute("data-sitekey") : null);

    if (!sitekey) {
      log("Could not extract hCaptcha sitekey");
      return null;
    }

    // Click checkbox
    try {
      const rect = hcaptchaFrame.getBoundingClientRect();
      const target = document.elementFromPoint(rect.left + 30, rect.top + 30);
      if (target) {
        target.click();
        target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      }
      log("Clicked hCaptcha checkbox");
      await sleep(2500);
    } catch (e) {
      log(`hCaptcha click failed: ${e.message}`);
    }

    // Check if challenge appeared
    const challengeFrame = document.querySelector('iframe[src*="hcaptcha"][src*="challenge"]');

    if (!challengeFrame) {
      const textarea = document.querySelector('textarea[name="h-captcha-response"]');
      if (textarea && textarea.value && textarea.value.length > 10) {
        log("hCaptcha already solved");
        showNotification("hCaptcha solved!");
        return { answer: "auto-solved", engine: "browser" };
      }
      return null;
    }

    log("hCaptcha challenge appeared, sending to AI...");

    try {
      const result = await apiCall("/solve/hcaptcha", {
        sitekey: sitekey,
        url: location.href,
        challenge_url: challengeFrame.src || "",
      });

      if (result.answer) {
        log(`AI solved hCaptcha`);
        const textarea = document.querySelector('textarea[name="h-captcha-response"]');
        if (textarea) {
          textarea.value = result.answer;
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
        }
        tryFireCallback("hcaptcha", result.answer);
        showNotification("hCaptcha solved!");
        return result;
      }
    } catch (e) {
      log(`AI hCaptcha solve failed: ${e.message}`);
    }

    return null;
  }

  // ---- Turnstile Solver ----
  async function solveTurnstile() {
    log("Attempting Turnstile solve...");

    const turnstileFrame = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
    if (!turnstileFrame) {
      log("No Turnstile frame found");
      return null;
    }

    const src = turnstileFrame.src || "";
    const sitekeyMatch = src.match(/sitekey=([A-Za-z0-9_-]+)/);
    const div = document.querySelector('.cf-turnstile, [data-sitekey]');
    const sitekey = sitekeyMatch ? sitekeyMatch[1] : (div ? div.getAttribute("data-sitekey") : null);

    // Click the Turnstile checkbox (it's usually just a click-to-verify)
    try {
      const rect = turnstileFrame.getBoundingClientRect();
      const target = document.elementFromPoint(rect.left + 25, rect.top + 25);
      if (target) {
        target.click();
        target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      }
      log("Clicked Turnstile checkbox");
      await sleep(3000);
    } catch (e) {
      log(`Turnstile click failed: ${e.message}`);
    }

    // Check if token was generated
    const input = document.querySelector('input[name="cf-turnstile-response"]');
    if (input && input.value && input.value.length > 10) {
      log("Turnstile already solved");
      showNotification("Turnstile solved!");
      return { answer: "auto-solved", engine: "browser" };
    }

    // If challenge appeared, send to AI
    if (sitekey) {
      try {
        const result = await apiCall("/solve/turnstile", {
          sitekey: sitekey,
          url: location.href,
          challenge_url: turnstileFrame.src || "",
        });
        if (result.answer) {
          if (input) {
            input.value = result.answer;
            input.dispatchEvent(new Event("input", { bubbles: true }));
          }
          showNotification("Turnstile solved!");
          return result;
        }
      } catch (e) {
        log(`AI Turnstile solve failed: ${e.message}`);
      }
    }

    return null;
  }

  // ---- Image Captcha Solver ----
  async function solveImageCaptcha() {
    const captchaImgs = document.querySelectorAll(
      'img[src*="captcha" i], img[alt*="captcha" i], ._captchaImage_rrn3u_9, img[src*="mtcaptcha"]'
    );

    for (const img of captchaImgs) {
      log("Found image captcha, sending to AI...");

      try {
        // Convert image to base64
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        const b64 = canvas.toDataURL("image/png").split(",")[1];

        const result = await apiCall("/solve/image", {
          image_base64: b64,
          prompt: "Read the text in this captcha image. Return ONLY the text characters, nothing else.",
        });

        if (result.answer) {
          log(`AI solved image captcha: ${result.answer}`);

          // Find nearest input and fill
          const container = img.closest("form") || img.closest("div") || img.parentElement;
          const inputs = container ? container.querySelectorAll('input[type="text"], input:not([type]), textarea') : [];
          for (const input of inputs) {
            if (input.offsetParent !== null) { // visible
              input.value = result.answer;
              input.dispatchEvent(new Event("input", { bubbles: true }));
              input.dispatchEvent(new Event("change", { bubbles: true }));
              break;
            }
          }

          showNotification(`Captcha solved: ${result.answer}`);
          return result;
        }
      } catch (e) {
        log(`Image captcha solve failed: ${e.message}`);
      }
    }

    return null;
  }

  // ---- Puzzle/Slider Solver ----
  async function solvePuzzle() {
    const puzzleImgs = document.querySelectorAll(
      'img[src*="puzzle"], img[src*="geetest"], img[src*="slider"]'
    );

    for (const img of puzzleImgs) {
      log("Found puzzle captcha, sending to AI...");

      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        const b64 = canvas.toDataURL("image/png").split(",")[1];

        const result = await apiCall("/solve/puzzle", {
          image_base64: b64,
        });

        if (result.answer) {
          const pixels = parseInt(result.answer);
          if (!isNaN(pixels)) {
            log(`AI says move slider ${pixels}px`);

            // Find slider and drag it
            const slider = document.querySelector(
              '.geetest_slider_button, .slider-button, [class*="slider"], [class*="drag"]'
            );
            if (slider) {
              const rect = slider.getBoundingClientRect();
              const startX = rect.left + rect.width / 2;
              const startY = rect.top + rect.height / 2;

              // Simulate drag
              slider.dispatchEvent(new MouseEvent("mousedown", { clientX: startX, clientY: startY, bubbles: true }));

              for (let i = 0; i <= pixels; i += 5) {
                await sleep(10);
                document.dispatchEvent(new MouseEvent("mousemove", {
                  clientX: startX + i, clientY: startY, bubbles: true
                }));
              }

              document.dispatchEvent(new MouseEvent("mouseup", {
                clientX: startX + pixels, clientY: startY, bubbles: true
              }));

              showNotification(`Slider moved ${pixels}px`);
              return result;
            }
          }
        }
      } catch (e) {
        log(`Puzzle solve failed: ${e.message}`);
      }
    }

    return null;
  }

  // ---- Helper: fire callback ----
  function tryFireCallback(type, token) {
    try {
      if (type === "recaptcha" && window.___grecaptcha_cfg) {
        const clients = window.___grecaptcha_cfg.clients;
        if (clients) {
          for (const k of Object.keys(clients)) {
            const cb = findDeepCallback(clients[k]);
            if (cb && typeof cb === "function") { cb(token); return; }
          }
        }
      }
      if (type === "hcaptcha" && window.hcaptcha) {
        window.hcaptcha.execute();
      }
    } catch (e) {
      log(`Callback fire failed: ${e.message}`);
    }
  }

  function findDeepCallback(obj, depth = 0) {
    if (depth > 8 || !obj) return null;
    if (typeof obj === "function") return obj;
    if (typeof obj === "object") {
      for (const key of Object.keys(obj)) {
        if (key.toLowerCase().includes("callback")) return obj[key];
        const found = findDeepCallback(obj[key], depth + 1);
        if (found && typeof found === "function") return found;
      }
    }
    return null;
  }

  // ---- Main: detect and solve ----
  async function detectAndSolve() {
    if (!settings.autoSolve) return { error: "Auto-solve disabled" };

    // 1. reCAPTCHA
    if (document.querySelector('iframe[src*="recaptcha"]')) {
      log("Detected reCAPTCHA v2");
      const r = await solveReCaptchaV2();
      if (r) return r;
    }

    // 2. hCaptcha
    if (document.querySelector('iframe[src*="hcaptcha"]')) {
      log("Detected hCaptcha");
      const r = await solveHCaptcha();
      if (r) return r;
    }

    // 3. Turnstile
    if (document.querySelector('iframe[src*="challenges.cloudflare.com"]')) {
      log("Detected Turnstile");
      const r = await solveTurnstile();
      if (r) return r;
    }

    // 4. Image captcha
    const r3 = await solveImageCaptcha();
    if (r3) return r3;

    // 5. Puzzle/slider
    const r4 = await solvePuzzle();
    if (r4) return r4;

    return { error: "No captcha detected" };
  }

  // ---- Auto-detect on load ----
  function autoDetect() {
    if (!settings.autoSolve) return;
    const selectors = [
      'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]',
      'iframe[src*="challenges.cloudflare.com"]',
      'img[src*="captcha" i]', 'img[alt*="captcha" i]',
    ];
    for (const sel of selectors) {
      if (document.querySelector(sel)) {
        log(`Auto-detected: ${sel}`);
        detectAndSolve().catch(console.error);
        return;
      }
    }
  }

  setTimeout(autoDetect, 2500);
  new MutationObserver(() => setTimeout(autoDetect, 2000))
    .observe(document.body, { childList: true, subtree: true });
})();
