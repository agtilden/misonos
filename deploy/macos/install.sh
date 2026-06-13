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

# The launcher's contents are part of the app's code identity, so the granted
# permission stays valid as long as this file does not change. Keep it minimal.
{
  echo '#!/bin/sh'
  echo "export PATH=\"$NODE_BIN_DIR:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin\""
  if [ -n "$HOST" ]; then
    echo "export MISONOS_BRIDGE_PUBLIC_HOST=$HOST"
  fi
  echo "cd \"$REPO\" || exit 1"
  echo 'exec npm start >> "$HOME/Library/Logs/misonos-bridge.out.log" 2>> "$HOME/Library/Logs/misonos-bridge.err.log"'
} > "$APP/Contents/MacOS/misonos"
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
