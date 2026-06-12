# grateful-smapi

A Sonos Music API (SMAPI) endpoint that exposes Grateful Dead recordings from archive.org as a music service on your speakers.

## Run

```
npm run dev -w @misonos/grateful-smapi
```

Defaults:
- Listens on `0.0.0.0:4319`
- Reads from `~/Documents/projects/grateful/gratefuldead.db`

Override with env vars `MISONOS_GRATEFUL_HOST`, `MISONOS_GRATEFUL_PORT`, `MISONOS_GRATEFUL_DB`, `MISONOS_GRATEFUL_NAME`.

## Register on a Sonos speaker

1. Find your bridge host's LAN IP (e.g. `192.168.1.50`) — the speakers need to reach this machine.
2. Pick any speaker IP and open `http://<speaker-ip>:1400/customsd.htm` in a browser.
3. Fill in:
   - **Service Name**: `Grateful Dead Archive`
   - **Endpoint URL**: `http://<your-LAN-IP>:4319/`
   - **Secure Endpoint URL**: leave blank (HTTP-only for now)
   - **Polling Interval**: `30`
   - **Authentication SOAP header policy**: `Anonymous`
   - **Container Type**: `Music Service`
4. Submit. The service should appear in the Sonos app under *Settings → Services & Voice → Add a Service* (or under "More Music" on older clients).
5. Add the service to your account in the Sonos app.

## Browse tree

- Root → By Year / By Venue / By Song
- Year → concerts (date — venue)
- Venue → concerts at that venue
- Song → concerts where that song was performed
- Concert → available recordings (sbd, aud, ...)
- Recording → tracks → tap to play

Track URLs are streamed directly from archive.org.
