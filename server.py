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
    print(f"[v1.3] _ai called with keys: {list(keys.keys()) if keys else 'EMPTY'}", flush=True)
    if not keys or not any(keys.values()):
        print("[v1.3] _ai: keys empty or all falsy", flush=True)
        return None
    try:
        from ai_engine import AIEngine
        print(f"[v1.3] _ai: creating AIEngine...", flush=True)
        engine = AIEngine(keys=keys)
        print(f"[v1.3] _ai: engine available={engine.available()}, providers={engine.providers()}", flush=True)
        return engine
    except Exception as e:
        print(f"[v1.3] _ai: FAILED: {e}", flush=True)
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
    return jsonify({"ok": True, "name": "Captcha Solver API", "version": "1.1.0"})


@app.route("/debug", methods=["POST"])
def debug():
    """Debug endpoint to check why AI engine fails."""
    data = request.json or {}
    k = data.get("api_keys", {})
    result = {"received_keys": list(k.keys())}

    if not k:
        result["error"] = "No keys received"
        return jsonify(result)

    try:
        from ai_engine import AIEngine
        result["import_ok"] = True
    except Exception as e:
        result["import_error"] = str(e)
        return jsonify(result)

    try:
        ai = AIEngine(keys=k)
        result["engine_created"] = True
        result["available"] = ai.available()
        result["providers"] = ai.providers()
    except Exception as e:
        result["engine_error"] = str(e)

    return jsonify(result)


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
    print(f"[v1.4] solve_image keys={list(k.keys()) if k else 'EMPTY'}", flush=True)
    print(f"[v1.4] any(values)={any(k.values()) if k else False}", flush=True)
    ai = _ai(k)
    print(f"[v1.4] ai={ai}, available={ai.available() if ai else 'N/A'}", flush=True)

    if ai and ai.available():
        try:
            answer = ai.solve_image(
                image_b64=data.get("image_base64"),
                image_url=data.get("image_url"),
                prompt=data.get("prompt", "Read the text in this captcha image. Return only the text."),
            )
            return jsonify({"answer": answer.strip(), "engine": "ai", "version": "1.4"})
        except Exception as e:
            print(f"[AI] image failed: {e}", flush=True)

    tc = _tc(k)
    if tc:
        try:
            uri = f"data:image/png;base64,{data['image_base64']}" if data.get("image_base64") else data.get("image_url")
            return jsonify({"answer": tc.normal(uri), "engine": "twocaptcha", "version": "1.4"})
        except Exception as e:
            print(f"[2Captcha] image failed: {e}", flush=True)

    return jsonify({"error": "Add Grok/Gemini/OpenRouter key in extension Settings", "version": "1.4"}), 503


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


@app.route("/solve/hcaptcha-drag", methods=["POST"])
def solve_hcaptcha_drag():
    """AI-powered hCaptcha drag challenge solver."""
    data = request.json or {}
    k = data.get("api_keys", {})
    ai = _ai(k)
    screenshot_b64 = data.get("screenshot_base64")

    if not ai or not ai.available():
        return jsonify({"error": "AI needed for hCaptcha drag. Add Grok/Gemini key."}), 503
    if not screenshot_b64:
        return jsonify({"error": "No screenshot provided"}), 400

    try:
        prompt = (
            "This is an hCaptcha drag challenge. The instruction says: "
            "'Drag ONE character to the matching character behind the lines'.\n\n"
            "Look at the image carefully:\n"
            "- On the LEFT side, there are animal characters stacked vertically with 'Move' buttons\n"
            "- On the RIGHT side, there are animal characters behind fence/grid lines\n\n"
            "Your task: Which animal on the LEFT needs to be dragged, and where on the RIGHT is its matching character?\n\n"
            "Return ONLY a JSON object like this:\n"
            '{"source_index": 0, "target_x": 250, "target_y": 150}\n'
            "- source_index: 0 for top animal, 1 for middle, 2 for bottom\n"
            "- target_x: horizontal pixel position of the matching animal on the right (0-400)\n"
            "- target_y: vertical pixel position of the matching animal (0-300)\n\n"
            "If you cannot determine, return: {\"skip\": true}\n"
            "Return ONLY the JSON, no explanation."
        )
        answer = ai.solve_image(image_b64=screenshot_b64, prompt=prompt)
        return jsonify({"answer": answer, "engine": "ai"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


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
