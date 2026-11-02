#!/bin/sh
# One-command local setup and start for the Smart Retry MVP.
# Usage, from anywhere:  ./app/bootstrap.sh
# Re-running is safe: it reuses the virtual environment, existing accounts and imported history.
set -e
APP="$(cd "$(dirname "$0")" && pwd)"
cd "$APP"

PY="${PYTHON:-python3}"
"$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)' || { echo "Python 3.12 or newer is required."; exit 1; }
"$PY" -c 'import sqlite3; v=tuple(map(int, sqlite3.sqlite_version.split("."))); exit(0 if v >= (3, 51, 3) else 1)' \
  || { echo "This Python links SQLite older than 3.51.3. Use a newer Python build."; exit 1; }
command -v node >/dev/null || { echo "Node 20 or newer is required to build the portal."; exit 1; }

if [ ! -x .venv/bin/python ]; then
  echo "Creating Python environment..."
  "$PY" -m venv .venv
fi
.venv/bin/pip install -q -r requirements.lock

if [ ! -f web/dist/index.html ]; then
  echo "Building the portal..."
  (cd web && npm ci --no-fund --no-audit && npm run build)
fi

echo "Preparing local data (history import and accounts)..."
.venv/bin/python setup_local.py
echo "Passwords are printed above only when accounts are first created. Keep them."
exec .venv/bin/python start.py
