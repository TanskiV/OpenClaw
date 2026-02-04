#!/bin/sh
set -e
set -x

# Diagnostics to help identify why the container exits with status 1
echo "--- Diagnostics start ---"
node -v || true
npm -v || true
echo "PATH=$PATH"
echo "ls -la /usr/local/bin || true"
ls -la /usr/local/bin || true
echo "ls -la /usr/local/lib/node_modules || true"
ls -la /usr/local/lib/node_modules || true
echo "npm -g list openclaw --depth 0 || true"
npm -g list openclaw --depth 0 || true
echo "which openclaw || true"
command -v openclaw || true
echo "--- Diagnostics end ---"

# Ensure global bin is in PATH
PATH="/usr/local/bin:$PATH"

PORT="${PORT:-10000}"

# 1) Prefer explicit global bin
if [ -x "/usr/local/bin/openclaw" ]; then
  exec /usr/local/bin/openclaw gateway --host 0.0.0.0 --port "$PORT"
fi

# 2) Try to discover bin from package.json and execute it (most robust)
PKG_JSON="/usr/local/lib/node_modules/openclaw/package.json"
if [ -f "$PKG_JSON" ]; then
  BIN_FIELD=$(node -e "try{const p=require('$PKG_JSON'); const b=p.bin; if(!b) console.log(''); else if(typeof b==='string') console.log(b); else if(typeof b==='object'){const k=Object.keys(b)[0]; console.log(b[k]);}}catch(e){console.log('');}")
  if [ -n "$BIN_FIELD" ]; then
    # Normalize and resolve the path
    BIN_FIELD="${BIN_FIELD#./}"
    BIN_PATH="/usr/local/lib/node_modules/openclaw/${BIN_FIELD}"

    if [ -x "$BIN_PATH" ]; then
      exec "$BIN_PATH" gateway --host 0.0.0.0 --port "$PORT"
    fi

    # If it's a JS/MJS file, run with node
    case "$BIN_PATH" in
      *.mjs|*.js)
        exec sh -c "node --trace-warnings --enable-source-maps \"$BIN_PATH\" gateway --host 0.0.0.0 --port \"$PORT\" 2>&1 | sed -u 's/^/[openclaw] /'"
        ;;
    esac
  fi

  # If no bin, try `main` field
  MAIN_FIELD=$(node -e "try{const p=require('$PKG_JSON'); console.log(p.main||'');}catch(e){console.log('');}")
  if [ -n "$MAIN_FIELD" ]; then
    MAIN_FIELD="${MAIN_FIELD#./}"
    MAIN_PATH="/usr/local/lib/node_modules/openclaw/${MAIN_FIELD}"
    if [ -f "$MAIN_PATH" ]; then
      case "$MAIN_PATH" in
        *.mjs|*.js)
          echo "--- openclaw: showing --help output ---"
          node --trace-warnings --enable-source-maps "$MAIN_PATH" --help 2>&1 | sed -u 's/^/[openclaw-help] /' || true
          echo "--- openclaw: showing 'gateway --help' output ---"
          node --trace-warnings --enable-source-maps "$MAIN_PATH" gateway --help 2>&1 | sed -u 's/^/[openclaw-gateway-help] /' || true

          exec sh -c "node --trace-warnings --enable-source-maps \"$MAIN_PATH\" gateway --host 0.0.0.0 --port \"$PORT\" 2>&1 | sed -u 's/^/[openclaw] /'"
          ;;
        *)
          exec "$MAIN_PATH" gateway --host 0.0.0.0 --port "$PORT"
          ;;
      esac
    fi
  fi
fi

# 3) Try common module entrypoint and common filenames
for p in "/usr/local/lib/node_modules/openclaw/openclaw.mjs" "/usr/local/lib/node_modules/openclaw/index.js" "/usr/local/lib/node_modules/openclaw/cli.js" "/usr/local/lib/node_modules/openclaw/bin/openclaw"; do
  if [ -f "$p" ]; then
    case "$p" in
      *.mjs|*.js)
        exec sh -c "node --trace-warnings --enable-source-maps \"$p\" gateway --host 0.0.0.0 --port \"$PORT\" 2>&1 | sed -u 's/^/[openclaw] /'"
        ;;
      *)
        exec "$p" gateway --host 0.0.0.0 --port "$PORT"
        ;;
    esac
  fi
done

# 4) (removed) fallback to npm exec --no-install — package has no bin so npm exec fails

# 5) Final fallback: rely on PATH (if present)
if command -v openclaw >/dev/null 2>&1; then
  exec sh -c "openclaw gateway --host 0.0.0.0 --port $PORT"
fi

# If we reached here — nothing started successfully
echo "ERROR: could not start openclaw via any method" >&2
exit 1