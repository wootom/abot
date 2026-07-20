#!/usr/bin/env bash
# Start abot-web inside WSL. Ensures PATH includes nvm node and ~/.local/bin
# (ttyd) so restartTtyd() can spawn ttyd. Host alias comes from ABOT_HOST_ALIAS
# (default host1) — set it per machine, e.g. ABOT_HOST_ALIAS=pcA.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_SESSION="${ABOT_WEB_TMUX_SESSION:-abot-web}"
PORT="${ABOT_WEB_PORT:-17900}"
ALIAS="${ABOT_HOST_ALIAS:-host1}"

export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true

NODE_BIN="${ABOT_NODE_BIN:-$(command -v node 2>/dev/null || true)}"
if [ -z "$NODE_BIN" ]; then
  for c in "$HOME"/.nvm/versions/node/*/bin/node; do [ -x "$c" ] && NODE_BIN="$c"; done
fi
if [ -z "$NODE_BIN" ]; then
  echo "node not found (run scripts/setup-wsl.sh first)" >&2
  exit 1
fi

TTYD_DIR="$HOME/.local/bin"
ABOT_PATH="$(dirname "$NODE_BIN"):$TTYD_DIR:/usr/local/bin:/usr/bin:/bin"

if tmux has-session -t "$SERVICE_SESSION" 2>/dev/null; then
  echo "abot-web session already running: $SERVICE_SESSION"
  exit 0
fi

if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port already in use: $PORT" >&2
  exit 1
fi

tmux new-session -d -s "$SERVICE_SESSION" \
  "cd '$ROOT' && PATH='$ABOT_PATH' ABOT_HOST_ALIAS='$ALIAS' '$NODE_BIN' server/abot-web.js"
echo "started $SERVICE_SESSION on http://127.0.0.1:$PORT/ (alias=$ALIAS)"
