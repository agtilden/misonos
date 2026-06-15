# lma-smapi

A Sonos Music API (SMAPI) endpoint that exposes the [Live Music Archive](https://archive.org/details/etree)
(archive.org's `etree` collection — thousands of taper-friendly bands) as a music service on your speakers.

Unlike `grateful-smapi` (which reads a prebuilt local SQLite DB), this service queries archive.org's
search and metadata APIs **live**, so it covers the whole archive without any local data.

## Run

```
npm run dev -w @misonos/lma-smapi
```

Defaults:
- Listens on `0.0.0.0:4322`
- Browses the `etree` collection on archive.org

Override with env vars `MISONOS_LMA_HOST`, `MISONOS_LMA_PORT`, `MISONOS_LMA_COLLECTION`, `MISONOS_LMA_NAME`.

## Register on a Sonos speaker

1. Find your host's LAN IP (e.g. `192.168.1.50`) — the speakers need to reach this machine.
2. Open `http://<speaker-ip>:1400/customsd.htm` in a browser.
3. Fill in:
   - **Service Name**: `Live Music Archive`
   - **Endpoint URL**: `http://<your-LAN-IP>:4322/`
   - **Secure Endpoint URL**: leave blank (HTTP-only for now)
   - **Polling Interval**: `3600`
   - **Authentication SOAP header policy**: `Anonymous`
   - **Container Type**: `Music Service`
4. Submit, then add the service to your account in the Sonos app
   (*Settings → Services & Voice → Add a Service*, or "More Music" on older clients).

## Browse tree

- Root → **Popular Bands** / **Bands A–Z**
- Popular Bands → bands by total downloads
- Bands A–Z → letter → bands
- Band → **All Recordings (by date)** + one entry per year
- Year / All Recordings → recordings (`date — venue`)
- Recording → tracks → tap to play

Long lists page through archive.org's `numFound`, so even bands with thousands of
recordings browse a window at a time. Track URLs stream directly from archive.org's
canonical `/download/` path (which 302-redirects to the live CDN host).
