# Captcha Solver

> Developed by **JOJIN JOHN**

AI-powered captcha solving tool that works as a Chrome extension with a cloud server backend. Solves reCAPTCHA, hCaptcha, Turnstile, image captchas, and more using Grok, Groq, OpenAI, Gemini, or OpenRouter.

**This project is protected under All Rights Reserved license. No reproduction, distribution, or commercial use is permitted without written consent.**

## Features

- **reCAPTCHA v2** — AI analyzes image grid, clicks correct tiles via Chrome extension
- **hCaptcha** — AI drag challenge solving with screenshot analysis
- **Cloudflare Turnstile** — Auto-click verification
- **Image/Text Captchas** — AI reads distorted text
- **Audio Captchas** — AI transcribes speech
- **Puzzle/Slider** — AI calculates pixel distance
- **2Captcha API** — Fallback for token-based solving
- **Chrome Extension** — Auto-detects and auto-solves captchas on any page
- **Cloud Server** — Runs 24/7 on Vercel (free tier)
- **Multiple AI Providers** — Grok, Groq, OpenAI, Gemini, OpenRouter with automatic fallback

## Quick Start

### 1. Deploy Server (Free)

```bash
# Push to GitHub, then deploy on Vercel (free, no credit card)
# Your server URL will be: https://captcha-solve.vercel.app
```

### 2. Install Extension

1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `extension/` folder
4. Click the extension icon → **Settings** tab
5. Add your API key (at least one):
   - **Grok** (free credits): https://console.x.ai/
   - **Groq** (free tier): https://console.groq.com/keys
   - **OpenRouter** (free models): https://openrouter.ai/keys
   - **Gemini** (free tier): https://aistudio.google.com/apikey
6. Click **Save Settings**
7. Server URL should be `https://captcha-solve.vercel.app`

### 3. Use

Visit any page with a captcha → click **Solve CAPTCHA on This Page** or let auto-solve handle it.

## API Providers (All Free)

| Provider | Free Tier | Model | Speed |
|----------|-----------|-------|-------|
| **Groq** | Yes | llama-3.2-90b-vision | Fastest |
| **Grok** | Credits | grok-2-vision | Fast |
| **OpenRouter** | Yes | gemini-2.5-flash | Fast |
| **Gemini** | Yes | gemini-2.5-flash | Medium |
| **OpenAI** | Paid | gpt-4o | Best quality |

## CLI Usage

```bash
pip install -r requirements.txt

# Start server locally
python main.py server

# Solve image captcha
python main.py solve image path/to/captcha.png

# Solve reCAPTCHA (needs 2Captcha key)
python main.py solve recaptcha SITEKEY URL

# Check balance
python main.py balance
```

## Project Structure

```
captcha-solver/
├── ai_engine.py          # AI engine (Grok/Groq/OpenAI/Gemini/OpenRouter)
├── server.py             # Flask API server (Vercel-compatible)
├── main.py               # CLI entry point
├── twocaptcha/           # 2Captcha Python library
├── extension/            # Chrome extension
│   ├── manifest.json     # Extension config
│   ├── popup.html/js     # Settings & control panel
│   ├── content.js        # Captcha detection & page interaction
│   ├── background.js     # Screenshot capture, AI calls, frame injection
│   └── icons/            # Extension icons
├── requirements.txt      # Python dependencies
├── vercel.json           # Vercel deployment config
├── Dockerfile            # Docker deployment
├── .env.example          # Environment variables template
├── LICENSE               # All Rights Reserved (JOJIN JOHN)
└── README.md             # This file
```

## Environment Variables

```env
# At least one AI provider key needed
GROQ_API_KEY=gsk_...          # Free, fastest
XAI_API_KEY=xai-...           # Grok, has free credits
OPENROUTER_API_KEY=sk-or-...  # Free models available
GOOGLE_API_KEY=AIza...        # Gemini free tier
OPENAI_API_KEY=sk-...         # Paid, best quality

# Optional: 2Captcha API
TWOCAPTCHA_API_KEY=...

# Server config
SERVER_HOST=127.0.0.1
SERVER_PORT=5555
```

## Security

- API keys are stored in the browser extension's `chrome.storage.local`
- Keys are sent per-request to the server — **never stored on the server**
- The server is stateless — no database, no logs of your keys
- All communication is over HTTPS
- The extension only runs on pages where you click "Solve"

## Limitations

- reCAPTCHA image challenges: AI identifies tiles but clicking relies on Chrome extension injection
- Some reCAPTCHA challenges may require multiple attempts
- Free AI providers have rate limits
- Vercel free tier may sleep after inactivity (wakes on first request)

## Developed By

**JOJIN JOHN** — [GitHub](https://github.com/jojin1709)

## License

All Rights Reserved. Copyright (c) 2025 JOJIN JOHN. See [LICENSE](LICENSE) for details.
No reproduction, distribution, or commercial use without written consent.
