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
open ~/Applications/MiSonos.app                              # start
pkill -f 'MiSonos.app/Contents/MacOS/misonos'               # stop (kills launcher; children follow)
tail -f ~/Library/Logs/misonos-bridge.out.log
tail -f ~/Library/Logs/misonos-bridge.err.log
```

> Stop with `pkill`, not `osascript -e 'quit app "MiSonos"'` — the launcher is a
> plain C agent with no AppleEvent loop, so the AppleScript `quit` is a no-op.

## Updating to a new version

Run this on the closet Mac (over Screen Sharing — the `open` needs the GUI login
session). It pulls, rebuilds, recompiles + re-signs the bundle, and relaunches.

```sh
cd ~/Documents/projects/misonos

# 1. Get the new code.
git pull

# 2. Stop the running app (launcher + bridge + smapi/web children).
pkill -f 'MiSonos.app/Contents/MacOS/misonos' 2>/dev/null
pkill -f 'apps/bridge/dist/index.js'          2>/dev/null
pkill -f 'tsx watch src/index.ts'             2>/dev/null
pkill -f 'vite preview'                       2>/dev/null
sleep 2

# 3. Rebuild dist + bundle, recompile the launcher, re-sign, re-register login item.
#    install.sh runs `npm install` first, so new deps from the pull are picked up.
MISONOS_BRIDGE_PUBLIC_HOST=192.168.68.64 deploy/macos/install.sh

# 4. Relaunch from the GUI session.
open ~/Applications/MiSonos.app
sleep 5

# 5. Force a LAN call, then confirm the zones come back.
curl -s -X POST http://localhost:4317/api/discover >/dev/null
sleep 15
curl -s http://localhost:4317/api/zones | python3 -m json.tool | head
```

Sanity checks if step 5 is empty:

```sh
lsof -nP -iTCP:4317 -sTCP:LISTEN          # bridge is listening?
pgrep -fl 'MiSonos.app/Contents/MacOS'   # launcher resident (not exec'd away)?
tail -n 40 ~/Library/Logs/misonos-bridge.err.log
```

**A source process is missing / never starts.** Each smapi source is a separate
process+port (grateful 4319, ytmusic 4321, lma 4322, podcast 4323). If one doesn't
appear, it almost certainly crashed on startup — most often a missing dependency
after a pull added one (e.g. the podcast source's `fast-xml-parser` /
`better-sqlite3`), which exits with `ERR_MODULE_NOT_FOUND` before it can `listen`.
`install.sh` now runs `npm install`, but verify directly:

```sh
tail -n 30 ~/Library/Logs/misonos-podcast.log    # or -grateful/-phish/-ytmusic/-lma
lsof -nP -iTCP:4323 -sTCP:LISTEN                  # podcast listening? (swap port per source)
( cd ~/Documents/projects/misonos && npm install ) # if a dep is missing
```

**Re-granting after an update.** The Local Network grant is tied to the bundle's
code hash (ad-hoc signature → identity *is* the cdhash). Any change to `run.sh`
or the launcher — i.e. most updates — produces a new hash, so macOS may drop the
grant and prompt again. If zones are `[]` and no prompt appeared, re-trigger it:

```sh
tccutil reset LocalNetwork com.misonos.bridge   # often fails on this macOS — ignore and continue
open ~/Applications/MiSonos.app
curl -s -X POST http://localhost:4317/api/discover >/dev/null   # then click Allow
```

If a stale "denied" decision is stuck and won't re-prompt, a reboot clears it
(`tccutil` is unreliable on this macOS version).
