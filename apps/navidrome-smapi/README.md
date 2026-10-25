# @misonos/navidrome-smapi

A MiSonos source server for your own music library on **Navidrome** — or any
server that speaks the Subsonic API (Gonic, Airsonic, …). Browse and search come
from the Subsonic JSON API; the bridge stream-proxies each track to Sonos like
every other source, so nothing has to be registered on the speakers.

Sonos can't decode **Opus** (or Opus-in-Ogg). Those files are transcoded by the
server on the fly — to MP3 at 320 kbps by default — while MP3, FLAC, AAC/ALAC,
WAV and AIFF stream untouched.

## Endpoints (JSON, consumed by the bridge)

- `GET /info` — descriptor (`capabilities: ["search"]`); **503** until configured,
  which keeps the source out of the picker.
- `GET /browse?id=` — root (Artists, Albums, Playlists, Genres, Starred) or a node.
  Albums offers Recently Added, Recently Played, Most Played, Random and A–Z.
- `GET /search?q=` — artists, albums and songs under section headers.
- `GET /track?id=` — a song's metadata plus this service's `/stream` URL.
- `GET /stream?id=` — the audio, proxied from the server with auth added.
- `GET /art?id=&size=` — cover art, proxied the same way.

The Subsonic token never leaves this process: track and art URLs point back here,
not at Navidrome.

## Config (env)

| Var | Default | Notes |
|-----|---------|-------|
| `MISONOS_NAVIDROME_SERVER_URL` | — | e.g. `http://127.0.0.1:4533`; required |
| `MISONOS_NAVIDROME_USER` / `MISONOS_NAVIDROME_PASSWORD` | — | required; a dedicated non-admin user is enough |
| `MISONOS_NAVIDROME_PUBLIC_URL` | Host header | base URL the **speakers** use for cover art — set to `http://<lan-ip>:4325` under Docker |
| `MISONOS_NAVIDROME_PORT` | `4325` | HTTP port |
| `MISONOS_NAVIDROME_TRANSCODE_FORMAT` | `mp3` | target for non-native files; must be a transcoding your server has |
| `MISONOS_NAVIDROME_MAX_BITRATE` | `320` | kbps for transcoded files |
| `MISONOS_NAVIDROME_NAME` | `Navidrome` | name shown in the source picker |

## Notes & limitations

- **Transcoded tracks are sized up front.** Sonos wants a Content-Length and seeks
  with byte ranges, which a transcode can't give until it's done. For constant-bitrate
  MP3, bytes map linearly to time: the response claims the song's duration (plus a
  second) at the transcode's bitrate — predicted from the song, then read off its
  first frame — and is cut or zero-padded to exactly that. A Range becomes a
  `timeOffset`. HEAD requests are answered without starting a transcode. With
  another `TRANSCODE_FORMAT`, transcoded tracks stream unsized and can't be seeked.
- Proxies in front of the server (e.g. a Cloudflare tunnel) can drop Content-Length
  from full responses; for files streamed raw it's restored from the file size.
- Browse lists aren't paged (the bridge has no paging): A–Z loads the whole album
  list, and Artists, Genres, Playlists and A–Z are cached for five minutes.
- Starring, ratings and scrobbling aren't wired up yet.
