#!/usr/bin/env bash
# abot macOS installer (native — no WSL).
#
# 1. Copies this abot-dist into ~/_abot.
# 2. Runs scripts/setup-mac.sh (ttyd, tmux, node, auth, roster).
# 3. Installs a LaunchAgent (com.abot.web) so abot auto-starts at login and
#    restarts on crash (KeepAlive).
# 4. Exposes the dashboard via Tailscale (serve for tailnet, funnel for public).
#
# Usage (run as your normal user, NOT sudo):
#   bash macos/install.sh --alias mac1 \
#     --url https://mac1.YOUR-TAILNET.ts.net:9443/ [--funnel 8443]
#
# Re-runnable. Skips steps already done.
set -euo pipefail

ALIAS="host1"; SELF_URL=""; SERVE_PORT=9443; FUNNEL_PORT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --alias) ALIAS="$2"; shift 2;;
    --url) SELF_URL="$2"; shift 2;;
    --serve) SERVE_PORT="$2"; shift 2;;
    --funnel) FUNNEL_PORT="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 1;;
  esac
done

step() { printf '\n=== %s ===\n' "$1"; }
DIST_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$HOME/_abot"

step "Copy abot-dist -> $ROOT"
mkdir -p "$ROOT"
# copy contents (exclude VCS/local state)
rsync -a --delete --exclude '.git' --exclude '.omc' --exclude '*.log' "$DIST_ROOT"/ "$ROOT"/ 2>/dev/null \
  || cp -R "$DIST_ROOT"/. "$ROOT"/
chmod +x "$ROOT"/scripts/*.sh "$ROOT"/macos/*.sh 2>/dev/null || true

step "WSL-free setup (ttyd, tmux, node, auth, roster)"
SELF_PUBLIC=""
if [ "$FUNNEL_PORT" -gt 0 ] && [ -n "$SELF_URL" ]; then
  SELF_PUBLIC="$(printf '%s' "$SELF_URL" | sed -E "s/:$SERVE_PORT\/?\$/:$FUNNEL_PORT\//")"
fi
ABOT_HOST_ALIAS="$ALIAS" ABOT_SELF_URL="$SELF_URL" ABOT_SELF_PUBLIC_URL="$SELF_PUBLIC" \
  bash "$ROOT/scripts/setup-mac.sh"

step "Install LaunchAgent (com.abot.web)"
PLIST="$HOME/Library/LaunchAgents/com.abot.web.plist"
mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s#__ROOT__#$ROOT#g" -e "s#__ALIAS__#$ALIAS#g" -e "s#__HOME__#$HOME#g" \
  "$ROOT/macos/com.abot.web.plist.template" > "$PLIST"
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "loaded $PLIST (RunAtLoad + KeepAlive)"

step "Tailscale expose"
TS="$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)"
if [ -x "$TS" ] || command -v "$TS" >/dev/null 2>&1; then
  "$TS" serve --bg --https="$SERVE_PORT" http://127.0.0.1:17900
  echo "tailnet Serve on :$SERVE_PORT -> 127.0.0.1:17900"
  if [ "$FUNNEL_PORT" -gt 0 ]; then
    "$TS" funnel --bg --https="$FUNNEL_PORT" http://127.0.0.1:17900
    echo "public Funnel on :$FUNNEL_PORT (id/pw required)"
  fi
else
  echo "tailscale CLI not found — expose manually:"
  echo "  tailscale serve --bg --https=$SERVE_PORT http://127.0.0.1:17900"
fi

step "Done"
echo "Dashboard (tailnet): ${SELF_URL:-https://<this-mac>.<tailnet>.ts.net:$SERVE_PORT/}"
[ -n "$SELF_PUBLIC" ] && echo "Dashboard (public): $SELF_PUBLIC"
echo "Login: see 'generated login' above (or ~/.abot-auth)."
echo "Add other hosts to the switcher: edit ~/.abot/hosts.json"
echo "Manage: launchctl unload/load $PLIST"
