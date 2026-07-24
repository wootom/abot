#!/usr/bin/env bash
# Install the abot 🟨 prompt marker into ~/.tmux.conf (idempotent).
# - backs up an existing config to ~/.tmux.conf.before-marker-<YYYYMMDD>
# - substitutes the tmux binary path for this machine
# - appends the marker block only if it is not already present
# - reloads it into the running tmux server (all sessions) if one exists
#
# Usage:  bash tmux/install-marker.sh
# Remove: delete the block between the ">>> abot 🟨 prompt marker >>>" and
#         "<<< abot 🟨 prompt marker <<<" lines, then reload tmux.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/abot-marker.tmux.conf"
CONF="$HOME/.tmux.conf"
SENTINEL=">>> abot 🟨 prompt marker >>>"

[ -f "$SRC" ] || { echo "missing $SRC" >&2; exit 1; }

TMUX_BIN="$(command -v tmux || true)"
[ -n "$TMUX_BIN" ] || { echo "tmux not found on PATH — install tmux first" >&2; exit 1; }

if [ -f "$CONF" ] && grep -qF "$SENTINEL" "$CONF"; then
  echo "marker already present in $CONF — nothing to append"
else
  if [ -f "$CONF" ]; then
    BACKUP="$CONF.before-marker-$(date +%Y%m%d)"
    [ -f "$BACKUP" ] || cp "$CONF" "$BACKUP"
    echo "backed up existing config -> $BACKUP"
  fi
  {
    printf '\n'
    sed "s#__TMUX_BIN__#$TMUX_BIN#g" "$SRC"
  } >> "$CONF"
  echo "appended marker block to $CONF (tmux=$TMUX_BIN)"
fi

# reload into the running server so every existing session picks it up now
if tmux info >/dev/null 2>&1; then
  tmux source-file "$CONF" && echo "reloaded into running tmux server"
else
  echo "no running tmux server — will apply on next tmux start"
fi

echo "done. Test: in a Codex/Claude prompt press Enter -> line is sent with a leading 🟨"
