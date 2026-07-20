#!/usr/bin/env bash
# Launcher run by the LaunchAgent (com.abot.web). Ensures the work tmux session
# exists, then execs abot-web in the FOREGROUND so launchd's KeepAlive can
# supervise it (auto-restart on crash, start at login). No WSL idle-shutdown
# issue on macOS, so no tail -f keepalive is needed — launchd is enough.
set -euo pipefail

ROOT="${ABOT_ROOT:-$HOME/_abot}"
WORK_SESSION="${ABOT_TMUX_SESSION:-dev}"
ALIAS="${ABOT_HOST_ALIAS:-host1}"

NODE_BIN="${ABOT_NODE_BIN:-$(command -v node 2>/dev/null || true)}"
if [ -z "$NODE_BIN" ]; then
  for c in "$HOME"/.nvm/versions/node/*/bin/node /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$c" ] && NODE_BIN="$c"
  done
fi
[ -n "$NODE_BIN" ] || { echo "node not found" >&2; exit 1; }

export PATH="$(dirname "$NODE_BIN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# work session for ttyd to attach to (detached; persists on its own)
tmux has-session -t "$WORK_SESSION" 2>/dev/null || tmux new-session -d -s "$WORK_SESSION"

cd "$ROOT"
exec env ABOT_HOST_ALIAS="$ALIAS" "$NODE_BIN" server/abot-web.js
