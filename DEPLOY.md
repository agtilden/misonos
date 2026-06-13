# Deploying MiSonos with Docker

Runs the whole stack (bridge + 3 SMAPI services + web PWA) on a Linux host on
your LAN.

## Requirements

- A **Linux** Docker host on the same LAN as your Sonos speakers. Host
  networking is required for Sonos discovery and playback, and it does **not**
  work on Docker Desktop for Mac/Windows.
- The Grateful Dead SQLite DB (`gratefuldead.db`, ~71 MB) — it lives outside
  this repo and must be copied to the host.

> Build on the target host (or an arch-matched machine). `better-sqlite3`
> compiles a native binary, so an image built for arm64 won't run on x86_64.

## Setup

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

## Notes

- **`MISONOS_LAN_IP` matters.** The bridge hands speakers stream URLs built from
  this address; if it's wrong (or auto-detected as the Tailscale IP) playback
  fails even though the UI loads.
- **YouTube Music sign-in** persists to `data/ytmusic.json` (mounted volume), so
  it survives restarts.
- **Phish.in** works without a key; set `MISONOS_PHISH_API_KEY` in `.env` if you
  have one.
- Logs: `docker compose logs -f bridge` (or `grateful` / `phish` / `ytmusic` /
  `web`).
- The web container is Caddy serving the built PWA and reverse-proxying `/api/*`
  to the bridge on `127.0.0.1:4317`, so the app stays single-origin.

## Ports

| Service  | Port | Who connects                        |
|----------|------|-------------------------------------|
| web      | 6173 | you / your phone                    |
| bridge   | 4317 | web (via Caddy) + Sonos speakers    |
| grateful | 4319 | bridge + Sonos speakers (SMAPI)     |
| phish    | 4320 | bridge + Sonos speakers (SMAPI)     |
| ytmusic  | 4321 | bridge + Sonos speakers (SMAPI)     |
