#!/usr/bin/env bash
# Idempotent boot for WSL: ensure the work tmux session and abot-web are up.
# Called at Windows startup by the keepalive scheduled task. Safe to re-run.
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true

WORK_SESSION="${ABOT_TMUX_SESSION:-dev}"
ROOT="${ABOT_ROOT:-$HOME/_abot}"

# work session for ttyd to attach to
tmux has-session -t "$WORK_SESSION" 2>/dev/null || tmux new-session -d -s "$WORK_SESSION"

# abot-web (idempotent: start script exits if session already exists)
bash "$ROOT/scripts/abot-web-start-wsl.sh"
