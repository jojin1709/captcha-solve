#!/usr/bin/env python3
"""
Unified Captcha Solver - CLI entry point.

Usage:
  python main.py server                   # Start the API server for browser extension
  python main.py solve image <path>       # Solve image captcha with AI
  python main.py solve recaptcha <key> <url>  # Solve reCAPTCHA via 2Captcha
  python main.py solve hcaptcha <key> <url>   # Solve hCaptcha via 2Captcha
  python main.py solve turnstile <key> <url>  # Solve Turnstile via 2Captcha
  python main.py solve audio <path>       # Transcribe audio captcha with AI
  python main.py solve text <image_path>  # Solve text captcha with AI
"""
import sys
import os
import json
import base64
import argparse
from dotenv import load_dotenv

load_dotenv()


def cmd_server(args):
    from server import main as server_main
    server_main()


def cmd_solve_image(args):
    from ai_engine import AIEngine
    engine = AIEngine()
    if not engine.available():
        print("Error: No AI provider configured. Set OPENAI_API_KEY or GOOGLE_API_KEY in .env")
        sys.exit(1)

    path = args.path
    if path.startswith("http"):
        b64 = None
        url = path
    else:
        with open(path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode("utf-8")
        url = None

    result = engine.solve_image(image_b64=b64, image_url=url)
    print(f"Answer: {result}")


def cmd_solve_text(args):
    from ai_engine import AIEngine
    engine = AIEngine()
    if not engine.available():
        print("Error: No AI provider configured. Set OPENAI_API_KEY or GOOGLE_API_KEY in .env")
        sys.exit(1)

    path = args.path
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("utf-8")

    result = engine.solve_image(
        image_b64=b64,
        prompt="Read the text in this captcha image and return only the text. No explanation."
    )
    print(f"Answer: {result}")


def cmd_solve_audio(args):
    from ai_engine import AIEngine
    engine = AIEngine()
    if not engine.available():
        print("Error: No AI provider configured. Set OPENAI_API_KEY or GOOGLE_API_KEY in .env")
        sys.exit(1)

    path = args.path
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("utf-8")

    result = engine.solve_audio(audio_b64=b64)
    print(f"Answer: {result}")


def cmd_solve_recaptcha(args):
    from twocaptcha import TwoCaptcha
    key = os.getenv("TWOCAPTCHA_API_KEY") or args.key
    if not key:
        print("Error: Set TWOCAPTCHA_API_KEY in .env or pass --key")
        sys.exit(1)

    solver = TwoCaptcha(key)
    result = solver.recaptcha(sitekey=args.sitekey, url=args.url, version=args.version)
    print(f"Answer: {result.get('code', '')}")


def cmd_solve_hcaptcha(args):
    from twocaptcha import TwoCaptcha
    key = os.getenv("TWOCAPTCHA_API_KEY") or args.key
    if not key:
        print("Error: Set TWOCAPTCHA_API_KEY in .env or pass --key")
        sys.exit(1)

    solver = TwoCaptcha(key)
    result = solver.hcaptcha(sitekey=args.sitekey, url=args.url)
    print(f"Answer: {result.get('code', '')}")


def cmd_solve_turnstile(args):
    from twocaptcha import TwoCaptcha
    key = os.getenv("TWOCAPTCHA_API_KEY") or args.key
    if not key:
        print("Error: Set TWOCAPTCHA_API_KEY in .env or pass --key")
        sys.exit(1)

    solver = TwoCaptcha(key)
    result = solver.turnstile(sitekey=args.sitekey, url=args.url)
    print(f"Answer: {result.get('code', '')}")


def cmd_balance(args):
    from twocaptcha import TwoCaptcha
    key = os.getenv("TWOCAPTCHA_API_KEY") or args.key
    if not key:
        print("Error: Set TWOCAPTCHA_API_KEY in .env or pass --key")
        sys.exit(1)

    solver = TwoCaptcha(key)
    balance = solver.balance()
    print(f"Balance: ${balance:.4f}")


def main():
    parser = argparse.ArgumentParser(
        description="Unified Captcha Solver (AI + 2Captcha API)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )
    subparsers = parser.add_subparsers(dest="command")

    # server
    subparsers.add_parser("server", help="Start API server for browser extension")

    # solve
    solve_parser = subparsers.add_parser("solve", help="Solve a captcha")
    solve_sub = solve_parser.add_subparsers(dest="captcha_type")

    # solve image
    p = solve_sub.add_parser("image", help="Solve image captcha with AI")
    p.add_argument("path", help="Image file path or URL")

    # solve text
    p = solve_sub.add_parser("text", help="Solve text captcha with AI")
    p.add_argument("path", help="Image file path")

    # solve audio
    p = solve_sub.add_parser("audio", help="Transcribe audio captcha with AI")
    p.add_argument("path", help="Audio file path")

    # solve recaptcha
    p = solve_sub.add_parser("recaptcha", help="Solve reCAPTCHA via 2Captcha")
    p.add_argument("sitekey", help="reCAPTCHA site key")
    p.add_argument("url", help="Page URL")
    p.add_argument("--version", default="v2", choices=["v2", "v3"])
    p.add_argument("--key", help="2Captcha API key (or set TWOCAPTCHA_API_KEY)")

    # solve hcaptcha
    p = solve_sub.add_parser("hcaptcha", help="Solve hCaptcha via 2Captcha")
    p.add_argument("sitekey", help="hCaptcha site key")
    p.add_argument("url", help="Page URL")
    p.add_argument("--key", help="2Captcha API key")

    # solve turnstile
    p = solve_sub.add_parser("turnstile", help="Solve Turnstile via 2Captcha")
    p.add_argument("sitekey", help="Turnstile site key")
    p.add_argument("url", help="Page URL")
    p.add_argument("--key", help="2Captcha API key")

    # balance
    p = subparsers.add_parser("balance", help="Check 2Captcha account balance")
    p.add_argument("--key", help="2Captcha API key")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(0)

    commands = {
        "server": cmd_server,
        "balance": cmd_balance,
    }

    if args.command == "solve":
        solve_commands = {
            "image": cmd_solve_image,
            "text": cmd_solve_text,
            "audio": cmd_solve_audio,
            "recaptcha": cmd_solve_recaptcha,
            "hcaptcha": cmd_solve_hcaptcha,
            "turnstile": cmd_solve_turnstile,
        }
        fn = solve_commands.get(args.captcha_type)
        if not fn:
            solve_parser.print_help()
            sys.exit(1)
        fn(args)
    else:
        commands[args.command](args)


if __name__ == "__main__":
    main()
