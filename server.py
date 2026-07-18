#!/usr/bin/env python3
"""
Captcha Solver API - works on Vercel (serverless) and local.
API keys are sent with each request from the extension.
"""
import os
import sys
import base64
import traceback
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)


def _get_ai(api_keys):
    """Create AI engine fresh with the keys from the request."""
    if not api_keys:
        return None
    try:
        from ai_engine import AIEngine
        # Set env vars from request keys
        key_map = {
            "openai": "OPENAI_API_KEY", "xai": "XAI_API_KEY",
            "groq": "GROQ_API_KEY", "openrouter": "OPENROUTER_API_KEY",
            "gemini": "GOOGLE_API_KEY", "twocaptcha": "TWOCAPTCHA_API_KEY",
        }
        for ext_key, env_var in key_map.items():
            val = api_keys.get(ext_key, "")
            if val:
                os.environ[env_var] = val
        return AIEngine()
    except Exception as e:
        print(f"[Server] AI init failed: {e}")
        return None


def _get_twocaptcha(api_keys):
    """Create 2Captcha solver with the key from the request."""
    key = (api_keys or {}).get("twocaptcha") or os.getenv("TWOCAPTCHA_API_KEY")
    if not key:
        return None
    try:
        from twocaptcha import TwoCaptcha
        return TwoCaptcha(key)
    except Exception as e:
        print(f"[Server] 2Captcha init failed: {e}")
        return None


def _keys(data):
    return (data or {}).get("api_keys", {})


# ---- Routes ----

@app.route("/")
def home():
    return jsonify({"ok": True, "name": "Captcha Solver API", "version": "1.0.0"})


@app.route("/status", methods=["GET"])
def status():
    return jsonify({"ok": True, "note": "Keys are sent per-request from extension"})


@app.route("/solve/image", methods=["POST"])
def solve_image():
    data = request.json or {}
    ak = _keys(data)
    ai = _get_ai(ak)
    tc = _get_twocaptcha(ak)

    # Try AI first
    if ai and ai.available():
        try:
            answer = ai.solve_image(
                image_b64=data.get("image_base64"),
                image_url=data.get("image_url"),
                prompt=data.get("prompt", "Read the text in this captcha image. Return only the text."),
            )
            if answer:
                return jsonify({"answer": answer.strip(), "engine": "ai"})
        except Exception as e:
            print(f"[AI] image failed: {e}")

    # Fallback to 2Captcha
    if tc:
        try:
            uri = f"data:image/png;base64,{data.get('image_base64', '')}" if data.get("image_base64") else data.get("image_url")
            result = tc.normal(uri)
            return jsonify({"answer": result, "engine": "twocaptcha"})
        except Exception as e:
            print(f"[2Captcha] image failed: {e}")

    return jsonify({"error": "Add an AI key (Grok/Gemini/OpenRouter) in extension Settings"}), 503


@app.route("/solve/recaptcha", methods=["POST"])
def solve_recaptcha():
    data = request.json or {}
    ak = _keys(data)
    tc = _get_twocaptcha(ak)
    sitekey = data.get("sitekey", "")
    url = data.get("url", "")

    if tc and sitekey:
        try:
            result = tc.recaptcha(sitekey=sitekey, url=url, version=data.get("version", "v2"))
            return jsonify({"answer": result.get("code", ""), "engine": "twocaptcha"})
        except Exception as e:
            print(f"[2Captcha] recaptcha failed: {e}")

    return jsonify({"error": "reCAPTCHA needs 2Captcha API key. Add it in Settings."}), 503


@app.route("/solve/hcaptcha", methods=["POST"])
def solve_hcaptcha():
    data = request.json or {}
    ak = _keys(data)
    tc = _get_twocaptcha(ak)

    if tc:
        try:
            result = tc.hcaptcha(sitekey=data.get("sitekey", ""), url=data.get("url", ""))
            return jsonify({"answer": result.get("code", ""), "engine": "twocaptcha"})
        except Exception as e:
            print(f"[2Captcha] hcaptcha failed: {e}")

    return jsonify({"error": "hCaptcha needs 2Captcha API key."}), 503


@app.route("/solve/turnstile", methods=["POST"])
def solve_turnstile():
    data = request.json or {}
    ak = _keys(data)
    tc = _get_twocaptcha(ak)

    if tc:
        try:
            result = tc.turnstile(sitekey=data.get("sitekey", ""), url=data.get("url", ""))
            return jsonify({"answer": result.get("code", ""), "engine": "twocaptcha"})
        except Exception as e:
            print(f"[2Captcha] turnstile failed: {e}")

    return jsonify({"error": "Turnstile needs 2Captcha API key."}), 503


@app.route("/solve/puzzle", methods=["POST"])
def solve_puzzle():
    data = request.json or {}
    ak = _keys(data)
    ai = _get_ai(ak)

    if ai and ai.available():
        try:
            answer = ai.solve_puzzle(
                image_b64=data.get("image_base64"),
                image_url=data.get("image_url"),
            )
            return jsonify({"answer": answer, "engine": "ai"})
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    return jsonify({"error": "Add an AI key in Settings for puzzle solving."}), 503


@app.route("/solve/audio", methods=["POST"])
def solve_audio():
    data = request.json or {}
    ak = _keys(data)
    ai = _get_ai(ak)

    if ai and ai.available():
        try:
            answer = ai.solve_audio(
                audio_b64=data.get("audio_b64"),
                audio_url=data.get("audio_url"),
            )
            return jsonify({"answer": answer, "engine": "ai"})
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    return jsonify({"error": "Add an AI key in Settings for audio solving."}), 503


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5555, debug=True)
