# Running MiSonos on macOS (Local Network permission)

The bridge discovers and controls Sonos speakers over the **local network** (SSDP
multicast + SOAP to `:1400`). On macOS Sequoia and later (incl. Tahoe / Darwin 25),
LAN access is gated by the **Local Network** privacy permission.

## The gotcha

macOS only grants Local Network access to **apps** that:

1. have a real **bundle identity** (code signature + `CFBundleIdentifier`), and
2. **declare the need** via `NSLocalNetworkUsageDescription` in `Info.plist`.

A bare CLI process — `npm start` / `node` launched from a shell, **SSH, tmux, or a
plain LaunchAgent** — has neither, so macOS **silently denies** its LAN traffic
(both multicast and unicast to the local subnet) and never shows a prompt. The
symptoms are nasty and misleading:

- `EHOSTUNREACH` on SSDP `M-SEARCH` and on `fetch`/SOAP to `192.168.x.y:1400`,
- internet calls (phish.in, YouTube Music) still work fine,
- the exact same code reaches the speakers when run from a granted app (e.g. a
  Terminal that was approved, or Claude Code),
- `/api/zones` returns `[]` even though `ping`/`curl` from a normal shell work.

This is **not** a bug in the bridge or in your network. It is the OS permission.

## The fix: run inside an app bundle

`deploy/macos/install.sh` builds a minimal `MiSonos.app` whose `Info.plist`
declares `NSLocalNetworkUsageDescription`, ad-hoc signs it, and registers it as a
hidden Login Item. Because it now has an app identity, macOS will prompt for (and
remember) Local Network access.

**The main executable must stay resident.** macOS attributes LAN access to the
*live, bundle-identified* process LaunchServices started. An earlier version used
a shell-script launcher that ended in `exec node …`; `exec` replaces the bundle
process with `/usr/local/bin/node` (foreign-signed, no bundle id, no usage
string), so there's no live bundle process left to be "responsible" → macOS blames
bare `node` and silently denies, **with no prompt even after a reboot**. The
installer therefore compiles a tiny C launcher (`Contents/MacOS/misonos`) that
**stays alive** and runs the stack (`Contents/Resources/run.sh`) as a **child** —
just like `npm start` under a granted Terminal works, because Terminal stays alive
as the responsible parent. (Requires Xcode Command Line Tools: `xcode-select
--install`.)

```sh
MISONOS_BRIDGE_PUBLIC_HOST=192.168.68.64 deploy/macos/install.sh
```

Then, **at the Mac's GUI** the first time:

1. `open ~/Applications/MiSonos.app`
2. `curl -s -X POST http://localhost:4317/api/discover >/dev/null`  (forces a LAN call)
3. Click **Allow** on the "MiSonos … Local Network" prompt.
4. `curl -s http://localhost:4317/api/zones` → named zones.

If the prompt does not appear, clear any stale decision and retry:

```sh
tccutil reset LocalNetwork com.misonos.bridge
```

### Notes / caveats

- The grant is tied to the app's code hash. The C launcher is intentionally tiny
  and static; if you change it (or `run.sh`), re-grant (rebuild + approve again).
- **Auto-start after reboot** needs a GUI login session: enable automatic login
  (System Settings → Users & Groups; requires FileVault off). Enable **Screen
  Sharing** so future prompts can be approved without pulling the box out.
- **Pin the IP.** `MISONOS_BRIDGE_PUBLIC_HOST` is baked into the launcher and must
  match the YouTube Music SMAPI registration on the speakers. Give the Mac a
  **DHCP reservation** so the IP never drifts (a moving IP was the original cause
  of the discovery/playback failures this setup was built to fix).
- Headless-only alternative: a configuration profile / MDM can pre-grant Local
  Network without a prompt, but that requires MDM enrollment and is out of scope
  here.

## Managing the service

```sh
open ~/Applications/MiSonos.app          # start
osascript -e 'quit app "MiSonos"'        # stop
tail -f ~/Library/Logs/misonos-bridge.out.log
tail -f ~/Library/Logs/misonos-bridge.err.log
```
