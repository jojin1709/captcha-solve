#!/usr/bin/env python3
"""
Unified AI engine for solving captchas.
Supports: OpenAI, Grok (xAI), Groq, OpenRouter, Google Gemini — with automatic fallback.
"""
import os
import re
import base64
import tempfile


class AIEngine:
    def __init__(self, keys=None):
        """
        keys: dict with optional keys:
            openai, xai, groq, openrouter, gemini
        """
        self._fallback_chain = []
        keys = keys or {}
        self._init_clients(keys)

    def _init_clients(self, keys):
        # --- OpenAI ---
        key = keys.get("openai") or os.getenv("OPENAI_API_KEY")
        if key:
            try:
                from openai import OpenAI
                client = OpenAI(api_key=key)
                self._fallback_chain.append(("openai", client, "gpt-4o"))
                print("[AI] OpenAI ready")
            except Exception as e:
                print(f"[AI] OpenAI init failed: {e}")

        # --- Grok / xAI ---
        key = keys.get("xai") or os.getenv("XAI_API_KEY") or os.getenv("GROK_API_KEY")
        if key:
            try:
                from openai import OpenAI
                client = OpenAI(api_key=key, base_url="https://api.x.ai/v1")
                self._fallback_chain.append(("grok", client, "grok-2-vision-1212"))
                print("[AI] Grok ready")
            except Exception as e:
                print(f"[AI] Grok init failed: {e}")

        # --- Groq (fast, free) ---
        key = keys.get("groq") or os.getenv("GROQ_API_KEY")
        if key:
            try:
                from openai import OpenAI
                client = OpenAI(api_key=key, base_url="https://api.groq.com/openai/v1")
                self._fallback_chain.append(("groq", client, "llama-3.2-11b-vision-preview"))
                print("[AI] Groq ready")
            except Exception as e:
                print(f"[AI] Groq init failed: {e}")

        # --- OpenRouter ---
        key = keys.get("openrouter") or os.getenv("OPENROUTER_API_KEY")
        if key:
            try:
                from openai import OpenAI
                model = os.getenv("OPENROUTER_MODEL", "google/gemini-2.5-flash")
                client = OpenAI(
                    api_key=key,
                    base_url="https://openrouter.ai/api/v1",
                    default_headers={"HTTP-Referer": "https://captcha-solver.local"},
                )
                self._fallback_chain.append(("openrouter", client, model))
                print(f"[AI] OpenRouter ready ({model})")
            except Exception as e:
                print(f"[AI] OpenRouter init failed: {e}")

        # --- Gemini ---
        key = keys.get("gemini") or os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
        if key:
            try:
                from google import genai
                client = genai.Client(api_key=key)
                model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
                self._fallback_chain.append(("gemini", client, model))
                print("[AI] Gemini ready")
            except Exception as e:
                print(f"[AI] Gemini init failed: {e}")

        if not self._fallback_chain:
            print("[AI] No providers available")

    def available(self):
        return len(self._fallback_chain) > 0

    def providers(self):
        return [name for name, _, _ in self._fallback_chain]

    # ---- Auto-fallback vision ----
    def _vision_fallback(self, image_b64=None, image_url=None, prompt="", max_tokens=256):
        last_error = None
        for name, client, model in self._fallback_chain:
            try:
                if name == "gemini":
                    return self._gemini_vision(client, model, image_b64, image_url, prompt)
                return self._openai_vision(client, model, image_b64, image_url, prompt, max_tokens)
            except Exception as e:
                last_error = e
                print(f"[AI] {name} failed: {e}")
                continue
        raise RuntimeError(f"All providers failed. Last: {last_error}")

    def _audio_fallback(self, audio_path):
        last_error = None
        for name, client, model in self._fallback_chain:
            try:
                if name == "gemini":
                    return self._gemini_audio(client, model, audio_path)
                return self._openai_audio(client, model, audio_path)
            except Exception as e:
                last_error = e
                print(f"[AI] {name} audio failed: {e}")
                continue
        raise RuntimeError(f"All providers failed for audio. Last: {last_error}")

    # ---- OpenAI-compatible vision ----
    @staticmethod
    def _openai_vision(client, model, image_b64=None, image_url=None, prompt="", max_tokens=256):
        content = []
        if image_b64:
            content.append({"type": "image_url", "image_url": {"url": f"data:image/png;base64,{image_b64}"}})
        elif image_url:
            content.append({"type": "image_url", "image_url": {"url": image_url}})
        content.append({"type": "text", "text": prompt})

        resp = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": "You are a captcha-solving assistant. Be precise and concise. Return only the answer."},
                {"role": "user", "content": content}
            ],
            temperature=0,
            max_tokens=max_tokens,
        )
        return resp.choices[0].message.content.strip()

    @staticmethod
    def _openai_audio(client, model, audio_path):
        try:
            with open(audio_path, "rb") as f:
                resp = client.audio.transcriptions.create(model="gpt-4o-transcribe", file=f)
            return re.sub(r'[^a-zA-Z0-9]', '', resp.text.strip())
        except Exception:
            with open(audio_path, "rb") as f:
                audio_b64 = base64.b64encode(f.read()).decode("utf-8")
            resp = client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": "Transcribe this audio captcha. Return only the text."},
                    {"role": "user", "content": [
                        {"type": "text", "text": "Transcribe the captcha audio."},
                        {"type": "image_url", "image_url": {"url": f"data:audio/mpeg;base64,{audio_b64}"}}
                    ]}
                ],
                temperature=0, max_tokens=128,
            )
            return re.sub(r'[^a-zA-Z0-9]', '', resp.choices[0].message.content.strip())

    # ---- Gemini ----
    @staticmethod
    def _gemini_vision(client, model, image_b64=None, image_url=None, prompt=""):
        from google.genai import types
        if image_b64:
            raw = base64.b64decode(image_b64)
            parts = [types.Part.from_bytes(data=raw, mime_type="image/png"), prompt]
        elif image_url:
            import httpx
            raw = httpx.get(image_url, follow_redirects=True, timeout=30).content
            parts = [types.Part.from_bytes(data=raw, mime_type="image/png"), prompt]
        else:
            raise ValueError("No image provided")
        resp = client.models.generate_content(model=model, contents=parts)
        return resp.text.strip()

    @staticmethod
    def _gemini_audio(client, model, audio_path):
        from google.genai import types
        with open(audio_path, "rb") as f:
            audio_bytes = f.read()
        audio_part = types.Part.from_bytes(data=audio_bytes, mime_type="audio/mpeg")
        resp = client.models.generate_content(
            model=model,
            config=types.GenerateContentConfig(system_instruction="Transcribe this audio captcha. Return only the text."),
            contents=["Transcribe the captcha.", audio_part]
        )
        return re.sub(r'[^a-zA-Z0-9]', '', resp.text.strip())

    # ---- Public API ----
    def solve_image(self, image_b64=None, image_url=None, prompt="Read the text in this captcha image. Return only the text.", **kw):
        return self._vision_fallback(image_b64, image_url, prompt)

    def solve_puzzle(self, image_b64=None, image_url=None, **kw):
        prompt = "Analyze this slider puzzle. Return ONLY the integer pixel distance to move. No text, just the number."
        raw = self._vision_fallback(image_b64, image_url, prompt, max_tokens=20)
        match = re.search(r'-?\d+', raw)
        return match.group(0) if match else raw

    def solve_audio(self, audio_b64=None, audio_url=None, **kw):
        if audio_b64:
            tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".mp3")
            tmp.write(base64.b64decode(audio_b64))
            tmp.close()
            path = tmp.name
        elif audio_url:
            import httpx
            raw = httpx.get(audio_url, follow_redirects=True, timeout=30).content
            tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".mp3")
            tmp.write(raw)
            tmp.close()
            path = tmp.name
        else:
            raise ValueError("No audio provided")
        try:
            return self._audio_fallback(path)
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass
