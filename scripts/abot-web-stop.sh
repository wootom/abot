#!/usr/bin/env bash
set -euo pipefail

SERVICE_SESSION="${ABOT_WEB_TMUX_SESSION:-abot-web}"

if tmux has-session -t "$SERVICE_SESSION" 2>/dev/null; then
  tmux kill-session -t "$SERVICE_SESSION"
  printf 'stopped %s\n' "$SERVICE_SESSION"
else
  printf 'abot-web session is not running: %s\n' "$SERVICE_SESSION"
fi
