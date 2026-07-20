#!/usr/bin/env bash
# One-time macOS setup for abot: install ttyd, tmux, node (Homebrew); generate
# auth + session secret; write a starter host roster. Idempotent — safe to re-run.
# Unlike Windows there is no WSL — the stack runs natively.
#
# Env (optional, usually passed by macos/install.sh):
#   ABOT_HOST_ALIAS   short name for this host        (default: host1)
#   ABOT_SELF_URL     this host's tailnet URL          (for hosts.json + fallback)
#   ABOT_SELF_PUBLIC_URL  this host's public Funnel URL (optional)
#   ABOT_AUTH_USER / ABOT_AUTH_PASS  login creds (auto-generated if unset)
set -euo pipefail

ALIAS="${ABOT_HOST_ALIAS:-host1}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$HOME/.abot"

log() { printf '\n=== %s ===\n' "$1"; }

log "Homebrew packages (ttyd, tmux)"
if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew not found. Install from https://brew.sh then re-run." >&2
  exit 1
fi
for pkg in ttyd tmux; do
  if ! command -v "$pkg" >/dev/null 2>&1; then brew install "$pkg"; fi
done

log "node"
if ! command -v node >/dev/null 2>&1; then
  # prefer nvm if present, else brew
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
  if ! command -v node >/dev/null 2>&1; then brew install node; fi
fi
node --version

log "auth credentials (~/.abot-auth)"
AUTH_FILE="$HOME/.abot-auth"
if [ ! -s "$AUTH_FILE" ]; then
  u="${ABOT_AUTH_USER:-abot}"
  p="${ABOT_AUTH_PASS:-$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | cut -c1-24)}"
  printf '%s:%s' "$u" "$p" > "$AUTH_FILE"
  chmod 600 "$AUTH_FILE"
  echo "generated login -> user: $u  pass: $p"
  echo "(saved to $AUTH_FILE, chmod 600. Copy the SAME file to other hosts for shared login.)"
else
  echo "keeping existing $AUTH_FILE"
fi

log "host roster (~/.abot/hosts.json)"
ROSTER="$HOME/.abot/hosts.json"
if [ ! -s "$ROSTER" ]; then
  if [ -n "${ABOT_SELF_URL:-}" ]; then
    pub=""
    [ -n "${ABOT_SELF_PUBLIC_URL:-}" ] && pub=",\"publicHref\":\"${ABOT_SELF_PUBLIC_URL}\""
    printf '[{"label":"%s","href":"%s"%s}]\n' "$ALIAS" "$ABOT_SELF_URL" "$pub" > "$ROSTER"
    echo "wrote starter roster with self host ($ALIAS). Add other hosts by editing $ROSTER"
  else
    cp "$ROOT/config/hosts.example.json" "$ROSTER"
    echo "copied example roster to $ROSTER — EDIT it with your real host URLs"
  fi
else
  echo "keeping existing $ROSTER"
fi

echo
echo "setup-mac.sh done. Start abot with: bash $ROOT/scripts/abot-web-start-mac.sh"
