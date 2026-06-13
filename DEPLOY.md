# Deploying MiSonos

Runs the whole stack (bridge + 3 SMAPI services + web PWA) on a host on your LAN.
Two ways to run it:

- **Option A — Docker** on a **Linux** host (uses host networking).
- **Option B — Native Node** on any host, **including macOS** (no Docker, so no
  host-networking limitation).

Both need the Grateful Dead SQLite DB (`gratefuldead.db`, ~71 MB) — it lives
outside this repo and must be copied to the host.

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

# 2. Drop the Grateful Dead DB in place:
mkdir -p data
cp /path/to/gratefuldead.db data/gratefuldead.db

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

## Option B — Native (Node, incl. macOS)

Use this when you don't have a Linux box — e.g. running it on a Mac. The
processes run directly on the host's network, so Sonos discovery and playback
work without Docker's host-networking caveat.

### Requirements

- **Node 22 LTS** (`node -v` → v22.x). On macOS: `brew install node@22`.
- **macOS only:** Xcode Command Line Tools for `better-sqlite3`'s native build:
  `xcode-select --install`.

### Setup

```sh
# 1. Clone and install (plain install — do NOT use --omit=dev; the build needs
#    tsc/tsx/vite, which are devDependencies):
git clone https://github.com/agtilden/misonos.git
cd misonos
npm install

# 2. Point at the right LAN IP and DB. These are read from the environment
#    (there is no .env loading for the native path), so export them first:

#    Your host's LAN IP the speakers can reach — NOT the Tailscale 100.x.
#    Find it on macOS with:  ipconfig getifaddr en0
export MISONOS_BRIDGE_PUBLIC_HOST=192.168.68.50

#    Only if the DB isn't at the default ~/Documents/projects/grateful/gratefuldead.db:
export MISONOS_GRATEFUL_DB="$HOME/path/to/gratefuldead.db"

# 3. Build the web app and run the whole stack:
npm start
```

`npm start` builds the web app (so the real service worker is generated — the
PWA is only installable from a production build) and runs the backends plus the
built web app served on **`:4173`**. Open `http://<lan-ip>:4173`.

For HTTPS / an installable PWA over Tailscale, on this host:

```sh
tailscale serve --bg 4173
```

then open `https://<host>.<tailnet>.ts.net` on your phone.

### Keep it running

`npm start` stops when you close the terminal. To keep it alive:

```sh
# quick:
nohup npm start > misonos.log 2>&1 &

# or cleaner, survives reboots/crashes:
npm i -g pm2
pm2 start npm --name misonos -- start
pm2 save && pm2 startup   # follow the printed command for launch-on-boot
```

### `npm start` vs `npm run dev`

- `npm start` — production-ish: built web, real service worker, installable PWA.
  A crashed source (e.g. a missing Grateful DB) does **not** take down the
  bridge. Use this to run it.
- `npm run dev` — hot-reload dev server on `:6173`. The dev-mode service worker
  is unreliable for PWA install. Use this only while editing code.

---

## Notes (both options)

- **The LAN IP matters.** The bridge hands speakers stream URLs built from it; if
  it's wrong (or auto-detected as the Tailscale `100.x` address) playback fails
  even though the UI loads. Set it explicitly (`MISONOS_LAN_IP` for Docker,
  `MISONOS_BRIDGE_PUBLIC_HOST` for native).
- **YouTube Music sign-in** persists (`data/ytmusic.json` under Docker;
  `~/.misonos/ytmusic.json` natively, override with `YTMUSIC_CREDENTIALS_PATH`),
  so it survives restarts.
- **Phish.in** works without a key; set `MISONOS_PHISH_API_KEY` if you have one.
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
