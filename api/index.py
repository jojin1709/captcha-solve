"""
Vercel serverless entry point.
Imports the Flask app from server.py and exposes it as the handler.
"""
import sys
import os

# Add parent directory to path so we can import server and ai_engine
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import app

# Vercel expects a WSGI app named 'app'
