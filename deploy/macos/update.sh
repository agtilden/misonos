#!/bin/bash
#
# One-command update cycle for the MiSonos macOS app:
#   pull → detect LAN IP → rebuild the bundle → stop the old processes → relaunch.
#
# This wraps deploy/macos/install.sh so you don't have to remember the IP incantation
# or hunt down the running node/tsx/vite processes by hand.
#
# Usage:
#   deploy/macos/update.sh              # pull, rebuild, restart
#   deploy/macos/update.sh --no-pull    # skip git pull (rebuild current checkout)
#   MISONOS_BRIDGE_PUBLIC_HOST=192.168.x.y deploy/macos/update.sh   # pin the IP
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP="${MISONOS_APP_PATH:-$HOME/Applications/MiSonos.app}"
PULL=1
for arg in "$@"; do
  case "$arg" in
    --no-pull) PULL=0 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

# The LAN IP your speakers can reach. Prefer the interface carrying the default
# route (the physical LAN), which sidesteps Tailscale (100.64/10) and link-local.
detect_lan_ip() {
  local iface ip
  iface="$(route -n get default 2>/dev/null | awk '/interface:/{print $2; exit}')"
  [ -n "$iface" ] && ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
  if [ -z "${ip:-}" ]; then
    for i in en0 en1 en2 en3 en4; do
      ip="$(ipconfig getifaddr "$i" 2>/dev/null || true)"
      [ -n "$ip" ] && break
    done
  fi
  printf '%s' "${ip:-}"
}

stop_running() {
  # Stop the resident bundle launcher and the stack it spawned. (Killing the
  # launcher doesn't reap its children, so target them explicitly — same patterns
  # the bundle's own run.sh clears on launch.)
  pkill -f "MiSonos.app/Contents/MacOS/misonos" 2>/dev/null || true
  pkill -f "tsx watch src/index.ts" 2>/dev/null || true
  pkill -f "vite preview" 2>/dev/null || true
  pkill -f "apps/bridge/dist/index.js" 2>/dev/null || true
}

if [ "$PULL" = 1 ]; then
  echo "==> Pulling latest (deploy/macos/update.sh --no-pull to skip)"
  git -C "$REPO" pull --ff-only
fi

HOST="${MISONOS_BRIDGE_PUBLIC_HOST:-$(detect_lan_ip)}"
if [ -z "$HOST" ]; then
  echo "==> WARNING: could not detect a LAN IP; the bridge will auto-detect." >&2
else
  echo "==> LAN IP: $HOST"
fi

# Rebuild the bundle FIRST, while the old instance keeps running — so a failed
# build leaves the current app untouched instead of taking everything down.
echo "==> Rebuilding the app bundle"
MISONOS_BRIDGE_PUBLIC_HOST="$HOST" "$REPO/deploy/macos/install.sh"

echo "==> Stopping the running instance"
stop_running
sleep 1

echo "==> Relaunching"
open "$APP"

echo
echo "==> Updated. Watch it come up with:"
echo "      tail -f ~/Library/Logs/misonos-bridge.out.log"
