# Deploying MiSonos

Runs the whole stack (bridge + 3 SMAPI services + web PWA) on a host on your LAN.
Two ways to run it:

- **Option A — Docker** on a **Linux** host (uses host networking).
- **Option B — macOS app bundle** (`MiSonos.app` via `install.sh`) — required on
  macOS, where Local Network access is gated behind a per-app permission.

Both need the Grateful Dead SQLite DB (`gratefuldead.db`, ~71 MB). It lives
outside this repo, in [`agtilden/grateful-dead-db`](https://github.com/agtilden/grateful-dead-db),
which packages it as rebuildable raw SQL. Clone it **next to this repo** and build
it:

```sh
git clone https://github.com/agtilden/grateful-dead-db
cd grateful-dead-db && ./build.sh   # writes ./gratefuldead.db
```

With `grateful-dead-db` as a sibling of the `misonos` checkout, the native
deploy (Option B) finds the DB automatically — no copy or rename. Docker (Option
A) needs it copied into `data/` because the container can't reach a sibling host
dir. Either way you can point `MISONOS_GRATEFUL_DB` at an explicit path instead.

---

## Option A — Docker (Linux host)

### Requirements

- A **Linux** Docker host on the same LAN as your Sonos speakers. Host
  networking is required for Sonos discovery and playback, and it does **not**
  work on Docker Desktop for Mac/Windows.

> Build on the target host (or an arch-matched machine). `better-sqlite3`
> compiles a native binary, so an image built for arm64 won't run on x86_64.

### Setup

```sh
# 1. Get the code onto the host, then from the repo root:
cp .env.example .env
# edit .env: set MISONOS_LAN_IP to this host's LAN IP (e.g. 192.168.68.50),
# NOT its Tailscale 100.x address.

# 2. Drop the Grateful Dead DB in place (build it from grateful-dead-db first):
mkdir -p data
cp /path/to/grateful-dead-db/gratefuldead.db data/gratefuldead.db

# 3. Build and start:
docker compose up -d --build
```

Open `http://<MISONOS_LAN_IP>:6173`. To reach it off-LAN over Tailscale with
HTTPS (needed for the installable PWA / service worker), run on the host:

```sh
tailscale serve --bg 6173
```

Logs: `docker compose logs -f bridge` (or `grateful` / `phish` / `ytmusic` /
`web`). The web container is Caddy serving the built PWA and reverse-proxying
`/api/*` to the bridge, so the app stays single-origin.

---

## Option B — macOS app bundle

Use this on a Mac (e.g. a closet Mac mini). You **cannot** just `npm start` on
modern macOS: Sequoia+ (Tahoe / Darwin 25) gates Local Network access behind a
per-app privacy permission, and a bare CLI process (`node`/`npm` from a shell,
SSH, `tmux`, `nohup`, `pm2`, or a plain LaunchAgent) has no bundle identity, so
macOS **silently denies** SSDP discovery and SOAP control — `/api/zones` comes
back `[]` with no prompt. The fix is to run inside a signed `MiSonos.app` that
declares `NSLocalNetworkUsageDescription`. `deploy/macos/install.sh` builds it.

> **Full rationale, troubleshooting, and the update recipe live in
> [`deploy/macos/README.md`](deploy/macos/README.md).** This is the short path.

### Requirements

- **Node 22 LTS** (`node -v` → v22.x): `brew install node@22`.
- **Xcode Command Line Tools** — for `better-sqlite3`'s native build *and* the
  bundle's C launcher: `xcode-select --install`.

### Setup

```sh
# 1. Clone (install.sh runs `npm install` itself):
git clone https://github.com/agtilden/misonos.git
cd misonos

# 2. Build the Grateful Dead DB in a sibling checkout — no copy needed, the
#    native deploy reads it there by default (or set MISONOS_GRATEFUL_DB):
( cd .. && git clone https://github.com/agtilden/grateful-dead-db && cd grateful-dead-db && ./build.sh )

# 3. Build + install the app bundle. The host IP is baked into the launcher and
#    must be the LAN IP the speakers reach — NOT the Tailscale 100.x. This grabs
#    the en0 LAN IP automatically (override if Wi-Fi isn't en0):
MISONOS_BRIDGE_PUBLIC_HOST=$(ipconfig getifaddr en0) deploy/macos/install.sh

# 4. Launch from the GUI, force a LAN call, then click "Allow" on the prompt:
open ~/Applications/MiSonos.app
curl -s -X POST http://localhost:4317/api/discover >/dev/null   # then click Allow
curl -s http://localhost:4317/api/zones                         # named zones come back
```

The installer registers `MiSonos.app` as a **hidden Login Item**, so it
auto-starts with the GUI session — no `pm2`/`nohup` needed. The web app is served
on **`:4173`**; open `http://<lan-ip>:4173`.

For HTTPS / an installable PWA over Tailscale, on this host:

```sh
tailscale serve --bg 4173
```

then open `https://<host>.<tailnet>.ts.net` on your phone.

### Updating / managing

To pull a new version, re-run `install.sh`, and re-grant if needed, follow the
**Updating to a new version** and **Managing the service** sections in
[`deploy/macos/README.md`](deploy/macos/README.md). In short:

```sh
git pull
pkill -f 'MiSonos.app/Contents/MacOS/misonos'                     # stop
MISONOS_BRIDGE_PUBLIC_HOST=$(ipconfig getifaddr en0) deploy/macos/install.sh
open ~/Applications/MiSonos.app                                   # relaunch from the GUI
```

> The Local Network grant is tied to the bundle's code hash, so an update may
> drop it and re-prompt — approve again after the `open`. See the deploy README
> if no prompt appears.

### Local dev (not deploy)

`npm run dev` runs a hot-reload web server on `:6173`. Run it from a Terminal
that already has Local Network permission (the Terminal app is the responsible
parent); the dev-mode service worker is unreliable for PWA install, so use it
only while editing code.

---

## Notes (both options)

- **The LAN IP matters.** The bridge hands speakers stream URLs built from it; if
  it's wrong (or auto-detected as the Tailscale `100.x` address) playback fails
  even though the UI loads. Set it explicitly (`MISONOS_LAN_IP` for Docker,
  `MISONOS_BRIDGE_PUBLIC_HOST` for native).
- **YouTube Music** searches and browses anonymously out of the box. Pasting your
  YT Music cookies (Settings → YouTube Music) unlocks Library and My Supermix; the
  cookies persist (`data/ytmusic-cookies.json` under Docker; `~/.misonos/ytmusic-cookies.json`
  natively, override with `YTMUSIC_COOKIES_PATH`) so they survive restarts.
- **Phish.in** works without a key; set `MISONOS_PHISH_API_KEY` if you have one.
- **Podcasts** work without a key (Apple Podcasts directory). Set
  `PODCASTINDEX_KEY` + `PODCASTINDEX_SECRET` (free from api.podcastindex.org) for
  richer Podcast Index search. Pinned shows persist in `podcasts.db`.
- **TuneIn** internet radio works without a key (the RadioTime OPML directory).
  Pinned stations persist in `tunein.db`. Optionally set `MISONOS_TUNEIN_PARTNER_ID`
  + `MISONOS_TUNEIN_SERIAL` if you have TuneIn partner credentials.
- **A missing Grateful DB** only breaks Grateful Dead browsing; the other sources
  and the bridge keep working.

## Ports

| Service  | Port            | Who connects                     |
|----------|-----------------|----------------------------------|
| web      | 6173 (Docker) / 4173 (native) | you / your phone   |
| bridge   | 4317            | web + Sonos speakers             |
| grateful | 4319            | bridge + Sonos speakers (SMAPI)  |
| phish    | 4320            | bridge + Sonos speakers (SMAPI)  |
| ytmusic  | 4321            | bridge + Sonos speakers (SMAPI)  |
| lma      | 4322            | bridge (Live Music Archive)      |
| podcasts | 4323            | bridge (RSS podcasts)            |
| tunein   | 4324            | bridge (TuneIn internet radio)   |
