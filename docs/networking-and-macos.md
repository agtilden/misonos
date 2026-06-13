# MiSonos networking & macOS notes

A field guide to the non-obvious failure modes this bridge has hit, what they
look like, and the fixes. Most "speakers won't show up / won't play" problems
trace back to one of these.

## 1. macOS Local Network permission (the big one)

**Symptom:** `/api/zones` returns `[]`; bridge logs show `EHOSTUNREACH` on SSDP
`M-SEARCH` (239.255.255.250) and on `fetch`/SOAP to `192.168.x.y:1400`, while
internet calls (phish.in, YouTube Music) work fine. `ping`/`curl` from a normal
shell reach the speakers, but the bridge can't.

**Cause:** On macOS Sequoia+/Tahoe, LAN access is gated by the **Local Network**
privacy permission. It is granted to an **app** (bundle id + code signature) that
declares the need via `NSLocalNetworkUsageDescription`, and the grant is
**inherited by child processes**. A bridge launched from `launchd`, a plain
LaunchAgent, the `npm → tsx → node` chain, or SSH/tmux inherits a responsible-app
ancestor that lacks the grant, so it's **silently denied** — and because bare
`node` has no bundle/usage-string, macOS never even prompts or lists it.

**Confirmed:** running `npm start` from a **GUI Terminal that already has Local
Network access** works (the bridge inherits Terminal's grant).

**Fix:** run under a granted app identity. Use `deploy/macos/install.sh`, which
builds a signed `MiSonos.app` declaring `NSLocalNetworkUsageDescription`. The
launcher runs the **bridge as the bundle's own `node` process** (final `exec`,
no `npm`/`tsx` child) — this is essential, because the LAN-accessing process must
itself be attributable to the bundle. The SMAPI sources + web run as background
children (they only listen / reach the internet, so they need no grant). First
launch prompts for Local Network; click Allow. `tccutil reset LocalNetwork` is
unreliable on current macOS — a reboot clears stuck/denied state if a prior bad
attempt cached a deny.

See `deploy/macos/README.md` for step-by-step install.

## 2. The host's LAN IP must not move

`MISONOS_BRIDGE_PUBLIC_HOST` is used to build stream-proxy URLs **and** is baked
into the YouTube Music SMAPI service registration stored *on the speakers*
(`customsd.htm`). If DHCP hands the Mac a new IP:

- Stream URLs point at the old IP → playback silently fails.
- The speaker calls the SMAPI service at the stale IP → `Play` returns UPnP
  **701** ("transition not available") even though the track is queued.

**Fix:** give the Mac a **DHCP reservation** so its IP is stable, and re-register
the YTM service if the IP ever changes (`POST /api/music/custom-presets/register`
with the current `hostOverride`). This is the original cause of the whole
discovery/playback saga.

## 3. Multi-homed / Tailscale interface selection

With Tailscale up, the host has the LAN interface (`en0`) plus several `utun`
interfaces. Two places naively pick "the first" interface and can choose the
tailnet, which speakers can't reach:

- **Stream URLs** (`ytmusic-smapi`): `bridgeStreamUrl` could hand the speaker a
  `100.x` Tailscale URL. Fixed: honor `MISONOS_BRIDGE_PUBLIC_HOST`, and
  `detectLanIp` skips CGNAT (100.64.0.0/10) + link-local.
- **SSDP egress**: discovery now pins the multicast interface to the LAN address
  (`setMulticastInterface`). (Note: this is separate from #1 — even with the
  right interface, the OS permission in #1 still has to be granted.)

## 4. Discovery resilience

- `discover()` used to end by re-calling `snapshot()`, which re-called
  `discover()` whenever a sweep returned zero zones — an **infinite loop** that
  hung every request after any transient blip. It now builds the snapshot
  directly.
- Concurrent discoveries are collapsed into one in-flight sweep (overlapping
  `reuseAddr` SSDP sockets otherwise steal each other's replies).
- A zero-result sweep keeps the last-known-good topology instead of blanking the
  zone list.

## 5. Playback 701s

UPnP **701** on `Play` has two distinct causes here:

- **Transport not pointed at the queue** (enqueue-then-play from an idle
  speaker). `transport("play")` now retries once after `SetAVTransportURI` to
  `x-rincon-queue:<uuid>#0`.
- **SMAPI service unresolvable on the speaker** — stale/missing registration
  (see #2). Re-register with the current host.
