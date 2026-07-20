#!/usr/bin/env bash
# One-time WSL setup for abot: install node (nvm), ttyd, tmux; generate auth +
# session secret; write a starter host roster. Idempotent — safe to re-run.
#
# Env (optional, usually passed by windows/install.ps1):
#   ABOT_HOST_ALIAS   short name for this host        (default: host1)
#   ABOT_SELF_URL     this host's tailnet URL          (for hosts.json + fallback)
#   ABOT_SELF_PUBLIC_URL  this host's public Funnel URL (optional)
#   ABOT_AUTH_USER / ABOT_AUTH_PASS  login creds (auto-generated if unset)
set -euo pipefail

ALIAS="${ABOT_HOST_ALIAS:-host1}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_BIN="$HOME/.local/bin"
mkdir -p "$LOCAL_BIN" "$HOME/.abot"

log() { printf '\n=== %s ===\n' "$1"; }

log "apt packages (tmux, curl, git)"
if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update -y
  sudo apt-get install -y tmux curl git ca-certificates
fi

log "node via nvm"
export NVM_DIR="$HOME/.nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
fi
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
if ! command -v node >/dev/null 2>&1; then
  nvm install --lts
fi
node --version

log "ttyd static binary"
if [ ! -x "$LOCAL_BIN/ttyd" ]; then
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) asset="ttyd.x86_64" ;;
    aarch64|arm64) asset="ttyd.aarch64" ;;
    armv7l) asset="ttyd.armhf" ;;
    *) echo "unsupported arch for ttyd prebuilt: $arch (install ttyd manually)"; asset="" ;;
  esac
  if [ -n "$asset" ]; then
    curl -fsSL -o "$LOCAL_BIN/ttyd" \
      "https://github.com/tsl0922/ttyd/releases/download/1.7.7/$asset"
    chmod +x "$LOCAL_BIN/ttyd"
  fi
fi
"$LOCAL_BIN/ttyd" --version || true

log "PATH boost in ~/.bashrc (idempotent)"
if ! grep -q 'abot: ~/.local/bin' "$HOME/.bashrc" 2>/dev/null; then
  {
    echo ''
    echo '# abot: ~/.local/bin (ttyd) on PATH'
    echo 'case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac'
  } >> "$HOME/.bashrc"
fi

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
echo "setup-wsl.sh done. Start abot with: bash $ROOT/scripts/abot-web-start-wsl.sh"
