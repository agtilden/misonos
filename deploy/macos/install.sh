#!/bin/bash
#
# Build & install the MiSonos macOS app bundle and register it to auto-start.
#
# WHY AN APP BUNDLE: macOS (Sequoia+/Tahoe) gates access to the Local Network
# behind a privacy permission that is granted to *apps* — identified by a code
# signature + bundle id — that declare the need via NSLocalNetworkUsageDescription
# in their Info.plist. A bare CLI process (node/npm launched from a shell, SSH,
# tmux, or a plain LaunchAgent) has no bundle identity and no usage string, so
# macOS silently denies its LAN access and never shows a prompt. The bridge MUST
# reach speakers on the LAN (SSDP discovery + SOAP control), so we wrap the stack
# in a minimal .app that declares the need and can therefore be granted.
#
# Usage:
#   MISONOS_BRIDGE_PUBLIC_HOST=192.168.x.y deploy/macos/install.sh
#
# After running, see the printed "Next steps" to launch and grant the permission.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP="${MISONOS_APP_PATH:-$HOME/Applications/MiSonos.app}"
HOST="${MISONOS_BRIDGE_PUBLIC_HOST:-}"
BUNDLE_ID="com.misonos.bridge"
NODE_BIN_DIR="$(cd "$(dirname "$(command -v node)")" && pwd)"

if [ -z "$HOST" ]; then
  echo "NOTE: MISONOS_BRIDGE_PUBLIC_HOST is not set."
  echo "      The bridge will auto-detect a LAN IP, but pinning it is strongly"
  echo "      recommended (and required to match the YouTube Music SMAPI"
  echo "      registration). Re-run as:"
  echo "        MISONOS_BRIDGE_PUBLIC_HOST=<lan-ip> $0"
  echo "      Also give this Mac a DHCP reservation so the IP never drifts."
  echo
fi

echo "Building $APP"
echo "  repo:  $REPO"
echo "  node:  $NODE_BIN_DIR"
echo "  host:  ${HOST:-<auto-detect>}"
echo

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>com.misonos.bridge</string>
    <key>CFBundleName</key>
    <string>MiSonos</string>
    <key>CFBundleDisplayName</key>
    <string>MiSonos Bridge</string>
    <key>CFBundleExecutable</key>
    <string>misonos</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <!-- macOS shows this string in the Local Network permission prompt and
         lists the app under System Settings > Privacy & Security > Local Network. -->
    <key>NSLocalNetworkUsageDescription</key>
    <string>MiSonos discovers and controls your Sonos speakers on the local network.</string>
    <!-- Agent app: no Dock icon, but can still present the permission prompt. -->
    <key>LSUIElement</key>
    <true/>
</dict>
</plist>
PLIST

# CRITICAL — why the main executable is a COMPILED C binary, not a shell script:
#
# macOS attributes Local Network access to the "responsible app" — the live,
# bundle-identified process that LaunchServices started. The earlier launcher was
# a shell script ending in `exec node …`; `exec` REPLACES the bundle process with
# /usr/local/bin/node (a foreign-signed binary, no bundle id, no usage string), so
# after the exec there is no live bundle process left to be responsible → macOS
# blames bare `node`, can't prompt, and silently denies. (Confirmed: even a reboot
# to clear stuck TCC state did NOT produce a prompt — the cause is the exec, not
# stuck state.)
#
# The fix mirrors what already works — `npm start` from a granted Terminal: the
# Terminal app stays alive as the responsible parent and the deep node child
# inherits its grant. So the bundle's main executable is now a tiny C program that
# STAYS RESIDENT and runs the bridge as a CHILD (never exec's away). The resident
# C binary carries the bundle's code identity + NSLocalNetworkUsageDescription, so
# the prompt fires for MiSonos.app and the child node inherits the grant. Spawn
# depth is irrelevant; a live app-identity parent is what matters.
echo "Building the bridge (dist) so the bundle can run it directly"
( cd "$REPO" && npm run build -w @misonos/sonos-protocol && npm run build -w @misonos/bridge ) >/dev/null

mkdir -p "$APP/Contents/Resources"
RUN_SH="$APP/Contents/Resources/run.sh"

# run.sh runs inside the CHILD shell the resident launcher spawns — it is free to
# `exec node` here, because that only replaces the child, not the bundle's main
# executable (which stays alive as the Local-Network-responsible app).
{
  echo '#!/bin/sh'
  echo "export PATH=\"$NODE_BIN_DIR:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin\""
  if [ -n "$HOST" ]; then
    echo "export MISONOS_BRIDGE_PUBLIC_HOST=$HOST"
  fi
  echo "cd \"$REPO\" || exit 1"
  echo 'LOG="$HOME/Library/Logs"'
  echo '# Clear any stale instances so a relaunch does not fight for ports.'
  echo 'pkill -f "tsx watch src/index.ts" 2>/dev/null'
  echo 'pkill -f "vite preview" 2>/dev/null'
  echo 'pkill -f "apps/bridge/dist/index.js" 2>/dev/null'
  echo 'sleep 1'
  echo '# Non-LAN services (speakers connect TO these; no Local Network grant needed).'
  echo 'npm run dev -w @misonos/grateful-smapi >> "$LOG/misonos-grateful.log" 2>&1 &'
  echo 'npm run dev -w @misonos/phish-smapi    >> "$LOG/misonos-phish.log" 2>&1 &'
  echo 'npm run dev -w @misonos/ytmusic-smapi  >> "$LOG/misonos-ytmusic.log" 2>&1 &'
  echo 'npm run dev -w @misonos/lma-smapi      >> "$LOG/misonos-lma.log" 2>&1 &'
  echo 'npm run dev -w @misonos/podcast-smapi  >> "$LOG/misonos-podcast.log" 2>&1 &'
  echo 'npm run preview -w @misonos/web        >> "$LOG/misonos-web.log" 2>&1 &'
  echo '# The bridge runs as a child of the resident C launcher (the bundle main'
  echo '# executable), which stays alive as the Local-Network-responsible app.'
  echo 'exec node apps/bridge/dist/index.js >> "$LOG/misonos-bridge.out.log" 2>> "$LOG/misonos-bridge.err.log"'
} > "$RUN_SH"
chmod +x "$RUN_SH"

# Compile the resident main executable. It posix_spawns the child shell that runs
# the stack and waits on it, so the bundle process never exec's away.
if ! command -v cc >/dev/null 2>&1; then
  echo "ERROR: 'cc' (Xcode Command Line Tools) is required to build the app launcher." >&2
  echo "       Install with: xcode-select --install" >&2
  exit 1
fi

LAUNCHER_C="$(mktemp -t misonos-launcher).c"
cat > "$LAUNCHER_C" <<'CSRC'
#include <spawn.h>
#include <sys/wait.h>

extern char **environ;

/* The bundle's main executable: stay resident (so macOS keeps attributing the
 * Local Network access to THIS app) and run the stack as a child shell. */
int main(int argc, char **argv) {
    char *args[] = { "/bin/sh", RUN_SCRIPT, (void *)0 };
    pid_t pid;
    if (posix_spawn(&pid, "/bin/sh", (void *)0, (void *)0, args, environ) != 0)
        return 1;
    int status;
    if (waitpid(pid, &status, 0) < 0)
        return 1;
    return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
}
CSRC

cc -O2 -DRUN_SCRIPT="\"$RUN_SH\"" -o "$APP/Contents/MacOS/misonos" "$LAUNCHER_C"
rm -f "$LAUNCHER_C"
chmod +x "$APP/Contents/MacOS/misonos"

echo "Ad-hoc signing the bundle (stable identity for the permission grant)"
codesign --force --deep -s - "$APP"

mkdir -p "$HOME/Library/Logs"

echo "Registering as a hidden Login Item (auto-start in the GUI session)"
osascript -e "tell application \"System Events\" to delete (every login item whose name is \"MiSonos\")" >/dev/null 2>&1 || true
osascript -e "tell application \"System Events\" to make login item at end with properties {path:\"$APP\", hidden:true, name:\"MiSonos\"}" >/dev/null 2>&1 || \
  echo "  (could not auto-register login item — add $APP under System Settings > General > Login Items manually)"

cat <<DONE

Installed: $APP

Next steps (do these at the Mac's GUI the first time):
  1. Launch it from the GUI so it registers in the login session:
         open "$APP"
     (or double-click it in Finder)
  2. Trigger a LAN call so macOS prompts:
         curl -s -X POST http://localhost:4317/api/discover >/dev/null
  3. Approve the "Local Network" prompt that appears on screen.
     If it does not appear, clear any stale decision and retry step 1-2:
         tccutil reset LocalNetwork $BUNDLE_ID
  4. Verify named zones come back:
         curl -s http://localhost:4317/api/zones

For an unattended closet box, also:
  - System Settings > Users & Groups > enable automatic login (requires FileVault off),
    so the GUI session — and therefore this Login Item — exists after a reboot.
  - System Settings > General > Sharing > enable Screen Sharing for future prompts.
  - Give this Mac a DHCP reservation for ${HOST:-its LAN IP}.

Manage it later:
  open "$APP"                         # start
  osascript -e 'quit app "MiSonos"'   # stop
  tail -f "$HOME/Library/Logs/misonos-bridge.out.log"
DONE
