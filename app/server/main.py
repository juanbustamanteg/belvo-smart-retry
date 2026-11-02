"""ASGI entry point used by start.py."""
from .api import create_app

app = create_app()
