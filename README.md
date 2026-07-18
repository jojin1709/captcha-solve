# Captcha Solver

Unified captcha-solving tool combining AI vision (OpenAI/Gemini) and 2Captcha API. Works as a **CLI tool** and a **Chrome extension**.

## Features

- **AI-powered solving** — Uses GPT-4o / Gemini to solve image captchas, text captchas, audio captchas, and puzzle sliders
- **2Captcha API** — Solves reCAPTCHA v2/v3, hCaptcha, Cloudflare Turnstile, and 30+ captcha types via the 2Captcha service
- **Browser extension** — Chrome extension that auto-detects and auto-solves captchas on any page
- **Local server** — REST API backend that the extension communicates with

## Quick Start

### 1. Install dependencies

```bash
pip install -r requirements.txt
```

### 2. Configure API keys

Copy `.env.example` to `.env` and fill in your keys:

```bash
cp .env.example .env
```

At least one of these is needed:
- `OPENAI_API_KEY` — for AI-based solving (image, text, audio, puzzle)
- `TWOCAPTCHA_API_KEY` — for reCAPTCHA, hCaptcha, Turnstile, etc.

### 3. Start the server

```bash
python main.py server
```

### 4. Load the Chrome extension

1. Open `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" and select the `extension/` folder
4. The extension icon appears — click it to see status

## CLI Usage

```bash
# Start server for browser extension
python main.py server

# Solve image captcha with AI
python main.py solve image path/to/captcha.png
python main.py solve image https://example.com/captcha.png

# Solve text captcha with AI
python main.py solve text path/to/text_captcha.png

# Transcribe audio captcha
python main.py solve audio path/to/audio.mp3

# Solve reCAPTCHA via 2Captcha API
python main.py solve recaptcha 6Le-wvkS... https://mysite.com

# Solve hCaptcha via 2Captcha API
python main.py solve hcaptcha SiteKey123 https://mysite.com

# Solve Cloudflare Turnstile
python main.py solve turnstile 0x1AAAA... https://mysite.com

# Check 2Captcha balance
python main.py balance
```

## Browser Extension

The extension automatically detects captchas on web pages and sends them to the local server for solving.

**Supported captcha types:**
- reCAPTCHA v2/v3
- hCaptcha
- Cloudflare Turnstile
- Image/text captchas
- FunCaptcha

**How it works:**
1. Content script scans the page for captcha iframes and elements
2. Captures the captcha image via screenshot
3. Sends it to the local server (`http://127.0.0.1:5555`)
4. Server solves using AI or 2Captcha API
5. Result is automatically filled in

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/status` | GET | Server health check |
| `/solve/image` | POST | Solve image/text captcha |
| `/solve/recaptcha` | POST | Solve reCAPTCHA |
| `/solve/hcaptcha` | POST | Solve hCaptcha |
| `/solve/turnstile` | POST | Solve Turnstile |
| `/solve/puzzle` | POST | Solve slider puzzle |
| `/solve/audio` | POST | Transcribe audio captcha |

## Project Structure

```
captcha-solver/
├── twocaptcha/           # 2Captcha Python API library
├── ai_engine.py          # AI solving engine (OpenAI + Gemini)
├── server.py             # Local REST server for extension
├── main.py               # CLI entry point
├── extension/            # Chrome extension
│   ├── manifest.json
│   ├── popup.html/js     # Extension popup UI
│   ├── content.js        # Captcha detection & auto-fill
│   ├── background.js     # API proxy
│   └── icons/
├── requirements.txt
├── .env.example
└── README.md
```

## License

MIT
