#!/usr/bin/env python3
"""
Local API server for the browser extension.
Supports full AI-based captcha solving including reCAPTCHA/hCaptcha/Turnstile.
Uses Selenium for browser interaction when needed.
"""
import os
import sys
import base64
import traceback
import tempfile
from flask import Flask, request, jsonify
from flask_cors import CORS
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
CORS(app)

_ai = None
_twocaptcha = None
_driver = None


def _init_engines(api_keys=None):
    global _ai, _twocaptcha
    if api_keys:
        key_map = {
            "openai": "OPENAI_API_KEY",
            "xai": "XAI_API_KEY",
            "groq": "GROQ_API_KEY",
            "openrouter": "OPENROUTER_API_KEY",
            "gemini": "GOOGLE_API_KEY",
            "twocaptcha": "TWOCAPTCHA_API_KEY",
        }
        for ext_key, env_var in key_map.items():
            val = api_keys.get(ext_key, "")
            if val:
                os.environ[env_var] = val

    if _ai is None:
        try:
            from ai_engine import AIEngine as _AI
            _ai = _AI()
            print(f"[Server] AI providers: {_ai.providers()}")
        except Exception as e:
            print(f"[Server] AI init failed: {e}")

    if _twocaptcha is None:
        key = os.getenv("TWOCAPTCHA_API_KEY")
        if key:
            try:
                from twocaptcha import TwoCaptcha
                _twocaptcha = TwoCaptcha(key)
                print("[Server] 2Captcha ready")
            except Exception as e:
                print(f"[Server] 2Captcha init failed: {e}")


def _reinit_if_keys(api_keys):
    global _ai, _twocaptcha
    if not api_keys:
        return
    changed = False
    key_map = {
        "openai": "OPENAI_API_KEY", "xai": "XAI_API_KEY",
        "groq": "GROQ_API_KEY", "openrouter": "OPENROUTER_API_KEY",
        "gemini": "GOOGLE_API_KEY", "twocaptcha": "TWOCAPTCHA_API_KEY",
    }
    for ext_key, env_var in key_map.items():
        val = api_keys.get(ext_key, "")
        if val and os.environ.get(env_var) != val:
            os.environ[env_var] = val
            changed = True
    if changed:
        _ai = None
        _twocaptcha = None
        _init_engines()


def _has_ai():
    return _ai is not None and _ai.available()


def _get_keys(data):
    return (data or {}).get("api_keys", {})


# ---- Selenium-based captcha solver (free, AI-powered) ----

def _get_driver():
    global _driver
    if _driver is None:
        try:
            from selenium import webdriver
            from selenium.webdriver.firefox.options import Options
            options = Options()
            options.add_argument("--headless")
            options.add_argument("--width=1280")
            options.add_argument("--height=900")
            _driver = webdriver.Firefox(options=options)
            print("[Server] Selenium Firefox driver ready")
        except Exception as e:
            print(f"[Server] Selenium init failed: {e}")
            print("[Server] Install: pip install selenium webdriver-manager")
            return None
    return _driver


def _solve_with_selenium(url, captcha_type="auto"):
    """Use Selenium + AI to solve captcha on a page."""
    driver = _get_driver()
    if not driver:
        return {"error": "Selenium not available. Install: pip install selenium webdriver-manager"}

    if not _has_ai():
        return {"error": "AI engine needed for browser-based solving."}

    try:
        driver.get(url)
        import time
        time.sleep(3)

        # Try to find and solve based on type
        if captcha_type in ("auto", "recaptcha"):
            return _solve_recaptcha_selenium(driver, url)
        elif captcha_type == "hcaptcha":
            return _solve_hcaptcha_selenium(driver, url)
        elif captcha_type == "turnstile":
            return _solve_turnstile_selenium(driver, url)

        # Auto-detect: try reCAPTCHA first, then hCaptcha, then Turnstile
        from selenium.webdriver.common.by import By
        frames = driver.find_elements(By.TAG_NAME, "iframe")
        for frame in frames:
            src = frame.get_attribute("src") or ""
            if "recaptcha" in src:
                return _solve_recaptcha_selenium(driver, url)
            if "hcaptcha" in src:
                return _solve_hcaptcha_selenium(driver, url)
            if "challenges.cloudflare.com" in src:
                return _solve_turnstile_selenium(driver, url)

        return {"error": "No known captcha found on page"}

    except Exception as e:
        traceback.print_exc()
        return {"error": str(e)}


def _solve_recaptcha_selenium(driver, url):
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC
    import time

    try:
        # Click reCAPTCHA checkbox
        recaptcha_frame = WebDriverWait(driver, 5).until(
            EC.presence_of_element_located((By.XPATH, "//iframe[contains(@src, 'recaptcha') and contains(@src, 'anchor')]"))
        )
        driver.switch_to.frame(recaptcha_frame)
        checkbox = WebDriverWait(driver, 5).until(
            EC.element_to_be_clickable((By.CLASS_NAME, "recaptcha-checkbox-border"))
        )
        checkbox.click()
        driver.switch_to.default_content()
        time.sleep(3)

        # Check if solved (no challenge)
        textarea = driver.find_element(By.NAME, "g-recaptcha-response")
        if textarea.get_attribute("value") and len(textarea.get_attribute("value")) > 10:
            return {"answer": textarea.get_attribute("value"), "engine": "selenium-ai", "method": "checkbox-only"}

        # Challenge appeared - screenshot it and send to AI
        challenge_frame = WebDriverWait(driver, 5).until(
            EC.presence_of_element_located((By.XPATH, "//iframe[contains(@src, 'recaptcha') and contains(@src, 'bframe')]"))
        )
        driver.switch_to.frame(challenge_frame)

        # Get instruction text
        try:
            instruction = driver.find_element(By.CLASS_NAME, "rc-imageselect-instructions")
            instruction_text = instruction.text
        except:
            instruction_text = "Select all images that match the description"

        # Screenshot the challenge
        challenge_png = driver.get_screenshot_as_png()
        challenge_b64 = base64.b64encode(challenge_png).decode("utf-8")

        # Send to AI
        prompt = (
            f"This is a reCAPTCHA image challenge. The instruction says: '{instruction_text}'. "
            f"Look at the grid of images. Return the numbers (1-indexed, left-to-right, top-to-bottom) "
            f"of ALL squares that match the description. Return ONLY numbers separated by commas. Example: 1,3,7"
        )
        answer = _ai.solve_image(image_b64=challenge_b64, prompt=prompt)
        driver.switch_to.default_content()

        if answer:
            # Parse tile numbers and click them
            import re
            numbers = [int(n.strip()) for n in re.findall(r'\d+', answer)]
            table = driver.find_element(By.CLASS_NAME, "rc-imageselect-table")
            tiles = table.find_elements(By.TAG_NAME, "td")

            for n in numbers:
                idx = n - 1
                if 0 <= idx < len(tiles):
                    tiles[idx].click()
                    time.sleep(0.3)

            time.sleep(1)

            # Click verify
            try:
                verify = driver.find_element(By.ID, "recaptcha-verify-button")
                verify.click()
                time.sleep(2)
            except:
                pass

            # Check result
            textarea = driver.find_element(By.NAME, "g-recaptcha-response")
            token = textarea.get_attribute("value")
            if token and len(token) > 10:
                return {"answer": token, "engine": "selenium-ai"}

        return {"error": "AI could not solve reCAPTCHA challenge"}

    except Exception as e:
        driver.switch_to.default_content()
        traceback.print_exc()
        return {"error": f"reCAPTCHA solve failed: {e}"}


def _solve_hcaptcha_selenium(driver, url):
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC
    import time

    try:
        hcaptcha_frame = WebDriverWait(driver, 5).until(
            EC.presence_of_element_located((By.XPATH, "//iframe[contains(@src, 'hcaptcha') and contains(@src, 'checkbox')]"))
        )
        driver.switch_to.frame(hcaptcha_frame)
        checkbox = WebDriverWait(driver, 5).until(
            EC.element_to_be_clickable((By.ID, "checkbox"))
        )
        checkbox.click()
        driver.switch_to.default_content()
        time.sleep(3)

        # Check if solved
        textarea = driver.find_element(By.NAME, "h-captcha-response")
        if textarea.get_attribute("value") and len(textarea.get_attribute("value")) > 10:
            return {"answer": textarea.get_attribute("value"), "engine": "selenium-ai"}

        # Challenge appeared
        challenge_frame = WebDriverWait(driver, 5).until(
            EC.presence_of_element_located((By.XPATH, "//iframe[contains(@src, 'hcaptcha') and contains(@src, 'challenge')]"))
        )
        driver.switch_to.frame(challenge_frame)

        try:
            instruction = driver.find_element(By.CLASS_NAME, "prompt-text")
            instruction_text = instruction.text
        except:
            instruction_text = "Select all matching images"

        challenge_png = driver.get_screenshot_as_png()
        challenge_b64 = base64.b64encode(challenge_png).decode("utf-8")

        prompt = (
            f"hCaptcha challenge: '{instruction_text}'. "
            f"Return numbers (1-indexed) of matching squares, separated by commas."
        )
        answer = _ai.solve_image(image_b64=challenge_b64, prompt=prompt)
        driver.switch_to.default_content()

        if answer:
            import re
            numbers = [int(n.strip()) for n in re.findall(r'\d+', answer)]
            table = driver.find_element(By.CLASS_NAME, "task-grid")
            tiles = table.find_elements(By.TAG_NAME, "td")

            for n in numbers:
                idx = n - 1
                if 0 <= idx < len(tiles):
                    tiles[idx].click()
                    time.sleep(0.3)

            time.sleep(1)
            try:
                verify = driver.find_element(By.CSS_SELECTOR, ".button-submit")
                verify.click()
                time.sleep(2)
            except:
                pass

            textarea = driver.find_element(By.NAME, "h-captcha-response")
            token = textarea.get_attribute("value")
            if token and len(token) > 10:
                return {"answer": token, "engine": "selenium-ai"}

        return {"error": "AI could not solve hCaptcha"}

    except Exception as e:
        driver.switch_to.default_content()
        return {"error": f"hCaptcha solve failed: {e}"}


def _solve_turnstile_selenium(driver, url):
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC
    import time

    try:
        turnstile_frame = WebDriverWait(driver, 10).until(
            EC.presence_of_element_located((By.XPATH, "//iframe[contains(@src, 'challenges.cloudflare.com')]"))
        )
        driver.switch_to.frame(turnstile_frame)
        checkbox = WebDriverWait(driver, 5).until(
            EC.element_to_be_clickable((By.ID, "cf-turnstile-response"))
        )
        checkbox.click()
        driver.switch_to.default_content()
        time.sleep(5)

        token_input = driver.find_element(By.NAME, "cf-turnstile-response")
        token = token_input.get_attribute("value")
        if token and len(token) > 10:
            return {"answer": token, "engine": "selenium-ai"}

        return {"error": "Turnstile not solved"}

    except Exception as e:
        driver.switch_to.default_content()
        return {"error": f"Turnstile solve failed: {e}"}


# ---- API Routes ----

@app.route("/status", methods=["GET"])
def status():
    _init_engines()
    selenium_ok = False
    try:
        from selenium import webdriver
        selenium_ok = True
    except:
        pass
    return jsonify({
        "ok": True,
        "ai_available": _has_ai(),
        "ai_providers": _ai.providers() if _ai else [],
        "twocaptcha_available": _twocaptcha is not None,
        "selenium_available": selenium_ok,
    })


@app.route("/setup", methods=["POST"])
def setup():
    data = request.json or {}
    api_keys = {k: v for k, v in data.items() if v}
    if not api_keys:
        return jsonify({"error": "No keys provided"}), 400
    global _ai, _twocaptcha
    _ai = None
    _twocaptcha = None
    _init_engines(api_keys)
    return jsonify({
        "ok": True,
        "ai_available": _has_ai(),
        "ai_providers": _ai.providers() if _ai else [],
    })


@app.route("/solve/image", methods=["POST"])
def solve_image():
    data = request.json or {}
    keys = _get_keys(data)
    _reinit_if_keys(keys)
    if not _has_ai():
        return jsonify({"error": "No AI configured. Add a key in Settings."}), 503
    try:
        answer = _ai.solve_image(
            image_b64=data.get("image_base64"),
            image_url=data.get("image_url"),
            prompt=data.get("prompt", "Read the text in this captcha image. Return only the text."),
        )
        return jsonify({"answer": answer, "engine": "ai"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/solve/recaptcha", methods=["POST"])
def solve_recaptcha():
    data = request.json or {}
    keys = _get_keys(data)
    _reinit_if_keys(keys)

    sitekey = data.get("sitekey", "")
    url = data.get("url", "")
    challenge_url = data.get("challenge_url", "")

    # Try 2Captcha first if available
    if _twocaptcha and sitekey:
        try:
            result = _twocaptcha.recaptcha(sitekey=sitekey, url=url)
            return jsonify({"answer": result.get("code", ""), "engine": "twocaptcha"})
        except:
            pass

    # Try Selenium + AI
    if _has_ai():
        driver = _get_driver()
        if driver:
            result = _solve_recaptcha_selenium(driver, url)
            return jsonify(result)

    return jsonify({"error": "No solver available. Add AI key or 2Captcha key in Settings."}), 503


@app.route("/solve/hcaptcha", methods=["POST"])
def solve_hcaptcha():
    data = request.json or {}
    keys = _get_keys(data)
    _reinit_if_keys(keys)

    sitekey = data.get("sitekey", "")
    url = data.get("url", "")

    if _twocaptcha and sitekey:
        try:
            result = _twocaptcha.hcaptcha(sitekey=sitekey, url=url)
            return jsonify({"answer": result.get("code", ""), "engine": "twocaptcha"})
        except:
            pass

    if _has_ai():
        driver = _get_driver()
        if driver:
            result = _solve_hcaptcha_selenium(driver, url)
            return jsonify(result)

    return jsonify({"error": "No solver available."}), 503


@app.route("/solve/turnstile", methods=["POST"])
def solve_turnstile():
    data = request.json or {}
    keys = _get_keys(data)
    _reinit_if_keys(keys)

    url = data.get("url", "")

    if _twocaptcha:
        sitekey = data.get("sitekey", "")
        if sitekey:
            try:
                result = _twocaptcha.turnstile(sitekey=sitekey, url=url)
                return jsonify({"answer": result.get("code", ""), "engine": "twocaptcha"})
            except:
                pass

    if _has_ai():
        driver = _get_driver()
        if driver:
            result = _solve_turnstile_selenium(driver, url)
            return jsonify(result)

    return jsonify({"error": "No solver available."}), 503


@app.route("/solve/puzzle", methods=["POST"])
def solve_puzzle():
    data = request.json or {}
    keys = _get_keys(data)
    _reinit_if_keys(keys)
    if not _has_ai():
        return jsonify({"error": "AI needed for puzzles."}), 503
    try:
        answer = _ai.solve_puzzle(
            image_b64=data.get("image_base64"),
            image_url=data.get("image_url"),
        )
        return jsonify({"answer": answer, "engine": "ai"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/solve/audio", methods=["POST"])
def solve_audio():
    data = request.json or {}
    keys = _get_keys(data)
    _reinit_if_keys(keys)
    if not _has_ai():
        return jsonify({"error": "AI needed for audio."}), 503
    try:
        answer = _ai.solve_audio(
            audio_b64=data.get("audio_b64"),
            audio_url=data.get("audio_url"),
        )
        return jsonify({"answer": answer, "engine": "ai"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


def main():
    host = os.getenv("SERVER_HOST", "127.0.0.1")
    port = int(os.getenv("SERVER_PORT", "5555"))
    _init_engines()
    print(f"\n{'='*50}")
    print(f"  Captcha Solver Server (Full AI Mode)")
    print(f"  http://{host}:{port}")
    print(f"  AI: {_ai.providers() if _ai else 'none'}")
    print(f"  Selenium: available")
    print(f"  2Captcha: {'ready' if _twocaptcha else 'not configured'}")
    print(f"{'='*50}\n")
    app.run(host=host, port=port, debug=False)


if __name__ == "__main__":
    main()
