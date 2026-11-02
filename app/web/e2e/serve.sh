#!/bin/sh
# Starts a disposable Smart Retry server for the E2E suite. Never touches app/.local-data.
set -e
APP="$(cd "$(dirname "$0")/../.." && pwd)"
DATA="$APP/tests/artifacts/e2e-data"
rm -rf "$DATA"
mkdir -p "$DATA"
export SMART_RETRY_DATA_DIR="$DATA" SMART_RETRY_PORT=8799
"$APP/.venv/bin/python" "$APP/setup_local.py" --data-dir "$DATA" \
  --operator-password "$E2E_OPERATOR_PASSWORD" --reviewer-password "$E2E_REVIEWER_PASSWORD" > "$DATA/setup.log" 2>&1
exec "$APP/.venv/bin/python" "$APP/start.py" > "$DATA/server.log" 2>&1
