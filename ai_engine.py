#!/usr/bin/env python3
"""
Unified AI engine for solving captchas.
Supports: OpenAI, Grok (xAI), Groq, OpenRouter, Google Gemini — with automatic fallback.
"""
import os
import re
import base64
import tempfile
from dotenv import load_dotenv

load_dotenv()


class AIEngine:
    def __init__(self):
        self._openai = None
        self._grok = None
        self._groq = None
        self._openrouter = None
        self._gemini = None
        self._fallback_chain = []
        self._init_clients()

    def _init_clients(self):
        # --- OpenAI ---
        key = os.getenv("OPENAI_API_KEY")
        if key:
            try:
                from openai import OpenAI
                self._openai = OpenAI(api_key=key)
                self._fallback_chain.append(("openai", self._openai, "gpt-4o"))
                print("[AI] OpenAI ready")
            except Exception as e:
                print(f"[AI] OpenAI init failed: {e}")

        # --- Grok / xAI ---
        key = os.getenv("XAI_API_KEY") or os.getenv("GROK_API_KEY")
        if key:
            try:
                from openai import OpenAI
                self._grok = OpenAI(api_key=key, base_url="https://api.x.ai/v1")
                self._fallback_chain.append(("grok", self._grok, "grok-2-vision-latest"))
                print("[AI] Grok (xAI) ready")
            except Exception as e:
                print(f"[AI] Grok init failed: {e}")

        # --- Groq (fast, free tier) ---
        key = os.getenv("GROQ_API_KEY")
        if key:
            try:
                from openai import OpenAI
                self._groq = OpenAI(api_key=key, base_url="https://api.groq.com/openai/v1")
                self._fallback_chain.append(("groq", self._groq, "llama-3.2-90b-vision-preview"))
                print("[AI] Groq ready (free tier)")
            except Exception as e:
                print(f"[AI] Groq init failed: {e}")

        # --- OpenRouter (access to 100+ models, many free) ---
        key = os.getenv("OPENROUTER_API_KEY")
        if key:
            try:
                from openai import OpenAI
                self._openrouter = OpenAI(
                    api_key=key,
                    base_url="https://openrouter.ai/api/v1",
                    default_headers={"HTTP-Referer": "https://captcha-solver.local"},
                )
                model = os.getenv("OPENROUTER_MODEL", "google/gemini-2.5-flash")
                self._fallback_chain.append(("openrouter", self._openrouter, model))
                print(f"[AI] OpenRouter ready (model: {model})")
            except Exception as e:
                print(f"[AI] OpenRouter init failed: {e}")

        # --- Google Gemini ---
        key = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
        if key:
            try:
                from google import genai
                self._gemini = genai.Client(api_key=key)
                self._fallback_chain.append(("gemini", None, os.getenv("GEMINI_MODEL", "gemini-2.5-flash")))
                print("[AI] Gemini ready")
            except Exception as e:
                print(f"[AI] Gemini init failed: {e}")

        if not self._fallback_chain:
            print("[AI] WARNING: No AI provider configured!")
            print("[AI] Set one of: OPENAI_API_KEY, XAI_API_KEY, OPENROUTER_API_KEY, GOOGLE_API_KEY")

    def available(self):
        return len(self._fallback_chain) > 0

    def providers(self):
        return [name for name, _, _ in self._fallback_chain]

    # ---- Internal: try a provider with automatic fallback ----
    def _vision_with_fallback(self, image_b64=None, image_url=None, prompt="", max_tokens=256):
        last_error = None
        for name, client, model in self._fallback_chain:
            try:
                if name == "gemini":
                    return self._gemini_vision(
                        client, model, image_b64=image_b64, image_url=image_url, prompt=prompt
                    )
                else:
                    return self._openai_compat_vision(
                        client, model, image_b64=image_b64, image_url=image_url,
                        prompt=prompt, max_tokens=max_tokens
                    )
            except Exception as e:
                last_error = e
                print(f"[AI] {name} failed: {e}, trying next...")
                continue
        raise RuntimeError(f"All AI providers failed. Last error: {last_error}")

    def _audio_with_fallback(self, audio_path, prompt="What is the captcha answer?"):
        last_error = None
        for name, client, model in self._fallback_chain:
            try:
                if name == "gemini":
                    return self._gemini_audio(client, model, audio_path, prompt=prompt)
                else:
                    return self._openai_compat_audio(client, model, audio_path, prompt=prompt)
            except Exception as e:
                last_error = e
                print(f"[AI] {name} audio failed: {e}, trying next...")
                continue
        raise RuntimeError(f"All AI providers failed for audio. Last error: {last_error}")

    # ---- OpenAI-compatible (works for OpenAI, Grok, OpenRouter) ----
    @staticmethod
    def _openai_compat_vision(client, model, image_b64=None, image_url=None, prompt="", max_tokens=256):
        content = []
        if image_b64:
            content.append({
                "type": "image_url",
                "image_url": {"url": f"data:image/png;base64,{image_b64}"}
            })
        elif image_url:
            content.append({
                "type": "image_url",
                "image_url": {"url": image_url}
            })
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
    def _openai_compat_audio(client, model, audio_path, prompt="What is the captcha answer?"):
        # OpenAI has native audio transcription; others don't, so we read the file
        # and send as base64 in a text prompt for non-OpenAI providers
        if "openai" in (getattr(client, "_custom_http_client", None) and "" or ""):
            # True OpenAI client — use transcription endpoint
            pass

        # For non-OpenAI, read audio as base64 and ask the model
        with open(audio_path, "rb") as f:
            audio_b64 = base64.b64encode(f.read()).decode("utf-8")

        # Try OpenAI transcription endpoint first (only works with real OpenAI)
        try:
            with open(audio_path, "rb") as f:
                resp = client.audio.transcriptions.create(
                    model="gpt-4o-transcribe",
                    file=f,
                    prompt=prompt
                )
            return re.sub(r'[^a-zA-Z0-9]', '', resp.text.strip())
        except Exception:
            pass

        # Fallback: send audio as base64 data URL in chat (works with multimodal models)
        resp = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": f"{prompt} Return only the captcha text, no explanation."},
                {"role": "user", "content": [
                    {"type": "text", "text": "This is an audio captcha file encoded in base64. Decode and transcribe it."},
                    {"type": "image_url", "image_url": {"url": f"data:audio/mpeg;base64,{audio_b64}"}}
                ]}
            ],
            temperature=0,
            max_tokens=128,
        )
        text = resp.choices[0].message.content.strip()
        return re.sub(r'[^a-zA-Z0-9]', '', text)

    # ---- Gemini ----
    @staticmethod
    def _gemini_vision(client, model, image_b64=None, image_url=None, prompt=""):
        from google.genai import types
        if image_b64:
            raw = base64.b64decode(image_b64)
            parts = [types.Part.from_bytes(data=raw, mime_type="image/png"), prompt]
        elif image_url:
            raw = AIEngine._download_url(image_url)
            parts = [types.Part.from_bytes(data=raw, mime_type="image/png"), prompt]
        else:
            raise ValueError("Provide image_b64 or image_url")
        resp = client.models.generate_content(model=model, contents=parts)
        return resp.text.strip()

    @staticmethod
    def _gemini_audio(client, model, audio_path, prompt="What is the captcha answer?"):
        from google.genai import types
        with open(audio_path, "rb") as f:
            audio_bytes = f.read()
        audio_part = types.Part.from_bytes(data=audio_bytes, mime_type="audio/mpeg")
        resp = client.models.generate_content(
            model=model,
            config=types.GenerateContentConfig(system_instruction=prompt),
            contents=["Transcribe the captcha from the audio. Return only the text.", audio_part]
        )
        return re.sub(r'[^a-zA-Z0-9]', '', resp.text.strip())

    # ---- Public API (with auto-fallback) ----
    def solve_image(self, image_b64=None, image_url=None, prompt="Read the text in this captcha image and return only the text. No explanation.", provider=None):
        if provider:
            return self._solve_with_single_provider(provider, "image", image_b64=image_b64, image_url=image_url, prompt=prompt)
        return self._vision_with_fallback(image_b64=image_b64, image_url=image_url, prompt=prompt)

    def solve_puzzle(self, image_b64=None, image_url=None, provider=None):
        prompt = (
            "Analyze this slider/captcha puzzle image. The goal is to find how many pixels "
            "the slider needs to move horizontally to solve the puzzle. "
            "Look at the puzzle piece and the empty slot/target. "
            "Return ONLY the integer number of pixels to move right. "
            "No explanation, no units, no text. Just the number. "
            "If already aligned, return 0. Cap at 300."
        )
        raw = self._vision_with_fallback(image_b64=image_b64, image_url=image_url, prompt=prompt, max_tokens=20)
        match = re.search(r'-?\d+', raw)
        return match.group(0) if match else raw

    def solve_recaptcha_images(self, image_b64=None, image_url=None, object_name="", provider=None):
        prompt = (
            f"Look at this reCAPTCHA image grid. I need to select all squares that contain '{object_name}'. "
            f"Return ONLY the numbers (1-indexed, left-to-right, top-to-bottom) of squares containing '{object_name}', "
            f"separated by commas. No explanation. Example: 1,3,7"
        )
        return self._vision_with_fallback(image_b64=image_b64, image_url=image_url, prompt=prompt, max_tokens=64)

    def solve_audio(self, audio_b64=None, audio_url=None, provider=None):
        if audio_b64:
            tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".mp3")
            tmp.write(base64.b64decode(audio_b64))
            tmp.close()
            audio_path = tmp.name
        elif audio_url:
            raw = self._download_url(audio_url)
            tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".mp3")
            tmp.write(raw)
            tmp.close()
            audio_path = tmp.name
        else:
            raise ValueError("Provide audio_b64 or audio_url")
        try:
            return self._audio_with_fallback(audio_path)
        finally:
            try:
                os.unlink(audio_path)
            except OSError:
                pass

    def _solve_with_single_provider(self, provider, task, **kwargs):
        for name, client, model in self._fallback_chain:
            if name == provider:
                if task == "image":
                    if name == "gemini":
                        return self._gemini_vision(client, model, **kwargs)
                    return self._openai_compat_vision(client, model, **kwargs)
                elif task == "audio":
                    return self._audio_with_fallback(kwargs.get("audio_path", ""))
        raise RuntimeError(f"Provider '{provider}' not available")

    @staticmethod
    def _download_url(url):
        import httpx
        resp = httpx.get(url, follow_redirects=True, timeout=30)
        resp.raise_for_status()
        return resp.content
