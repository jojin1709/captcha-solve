#!/usr/bin/env python3
"""
Captcha Solver API - Vercel-compatible.
Keys sent per-request from the extension.
"""
import os
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)


def _ai(keys):
    if not keys or not any(keys.values()):
        return None
    try:
        from ai_engine import AIEngine
        return AIEngine(keys=keys)
    except Exception as e:
        print(f"[AI] init failed: {e}")
        return None


def _tc(keys):
    key = (keys or {}).get("twocaptcha") or os.getenv("TWOCAPTCHA_API_KEY")
    if not key:
        return None
    try:
        from twocaptcha import TwoCaptcha
        return TwoCaptcha(key)
    except Exception as e:
        print(f"[2Captcha] init failed: {e}")
        return None


@app.route("/")
def home():
    return jsonify({"ok": True, "name": "Captcha Solver API", "version": "1.0.0"})


@app.route("/status", methods=["GET", "POST"])
def status():
    if request.method == "POST":
        data = request.json or {}
        k = data.get("api_keys", {})
        ai = _ai(k)
        tc = _tc(k)
        return jsonify({
            "ok": True,
            "ai_available": ai is not None and ai.available(),
            "ai_providers": ai.providers() if ai else [],
            "twocaptcha_available": tc is not None,
        })
    return jsonify({"ok": True, "note": "Send POST with api_keys to check engines"})


@app.route("/solve/image", methods=["POST"])
def solve_image():
    data = request.json or {}
    k = data.get("api_keys", {})
    ai = _ai(k)

    if ai and ai.available():
        try:
            answer = ai.solve_image(
                image_b64=data.get("image_base64"),
                image_url=data.get("image_url"),
                prompt=data.get("prompt", "Read the text in this captcha image. Return only the text."),
            )
            return jsonify({"answer": answer.strip(), "engine": "ai"})
        except Exception as e:
            print(f"[AI] image failed: {e}")

    tc = _tc(k)
    if tc:
        try:
            uri = f"data:image/png;base64,{data['image_base64']}" if data.get("image_base64") else data.get("image_url")
            return jsonify({"answer": tc.normal(uri), "engine": "twocaptcha"})
        except Exception as e:
            print(f"[2Captcha] image failed: {e}")

    return jsonify({"error": "Add Grok/Gemini/OpenRouter key in extension Settings"}), 503


@app.route("/solve/recaptcha", methods=["POST"])
def solve_recaptcha():
    data = request.json or {}
    k = data.get("api_keys", {})
    tc = _tc(k)
    if tc:
        try:
            r = tc.recaptcha(sitekey=data.get("sitekey", ""), url=data.get("url", ""), version=data.get("version", "v2"))
            return jsonify({"answer": r.get("code", ""), "engine": "twocaptcha"})
        except Exception as e:
            print(f"[2Captcha] recaptcha failed: {e}")
    return jsonify({"error": "reCAPTCHA needs 2Captcha API key in Settings."}), 503


@app.route("/solve/hcaptcha", methods=["POST"])
def solve_hcaptcha():
    data = request.json or {}
    k = data.get("api_keys", {})
    tc = _tc(k)
    if tc:
        try:
            r = tc.hcaptcha(sitekey=data.get("sitekey", ""), url=data.get("url", ""))
            return jsonify({"answer": r.get("code", ""), "engine": "twocaptcha"})
        except Exception as e:
            print(f"[2Captcha] hcaptcha failed: {e}")
    return jsonify({"error": "hCaptcha needs 2Captcha API key."}), 503


@app.route("/solve/turnstile", methods=["POST"])
def solve_turnstile():
    data = request.json or {}
    k = data.get("api_keys", {})
    tc = _tc(k)
    if tc:
        try:
            r = tc.turnstile(sitekey=data.get("sitekey", ""), url=data.get("url", ""))
            return jsonify({"answer": r.get("code", ""), "engine": "twocaptcha"})
        except Exception as e:
            print(f"[2Captcha] turnstile failed: {e}")
    return jsonify({"error": "Turnstile needs 2Captcha API key."}), 503


@app.route("/solve/puzzle", methods=["POST"])
def solve_puzzle():
    data = request.json or {}
    k = data.get("api_keys", {})
    ai = _ai(k)
    if ai and ai.available():
        try:
            return jsonify({"answer": ai.solve_puzzle(image_b64=data.get("image_base64"), image_url=data.get("image_url")), "engine": "ai"})
        except Exception as e:
            return jsonify({"error": str(e)}), 500
    return jsonify({"error": "Add an AI key in Settings."}), 503


@app.route("/solve/audio", methods=["POST"])
def solve_audio():
    data = request.json or {}
    k = data.get("api_keys", {})
    ai = _ai(k)
    if ai and ai.available():
        try:
            return jsonify({"answer": ai.solve_audio(audio_b64=data.get("audio_b64"), audio_url=data.get("audio_url")), "engine": "ai"})
        except Exception as e:
            return jsonify({"error": str(e)}), 500
    return jsonify({"error": "Add an AI key in Settings."}), 503


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5555, debug=True)
