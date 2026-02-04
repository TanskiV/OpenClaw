#!/bin/sh
set -e

# Ensure global bin is in PATH
PATH="/usr/local/bin:$PATH"

PORT="${PORT:-10000}"

# 1) Prefer explicit global bin
if [ -x "/usr/local/bin/openclaw" ]; then
  exec /usr/local/bin/openclaw gateway --host 0.0.0.0 --port "$PORT"
fi

# 2) Try npm's global bin at runtime
if command -v npm >/dev/null 2>&1; then
  BIN="$(npm bin -g 2>/dev/null)/openclaw"
  if [ -x "$BIN" ]; then
    exec "$BIN" gateway --host 0.0.0.0 --port "$PORT"
  fi
fi

# 3) Try common module path
if [ -f "/usr/local/lib/node_modules/openclaw/openclaw.mjs" ]; then
  exec node /usr/local/lib/node_modules/openclaw/openclaw.mjs gateway --host 0.0.0.0 --port "$PORT"
fi

# 4) Fallback to calling `openclaw` (may rely on PATH)
exec sh -c "openclaw gateway --host 0.0.0.0 --port $PORT"