# @misonos/tunein-smapi

A MiSonos source server for internet radio, backed by the **TuneIn** (RadioTime)
OPML directory. Discovery, search, and browsing all come from `opml.radiotime.com`
with `render=json`, so there's **no XML parsing and no API key** for basic use.
`Tune.ashx` resolves a station to its stream URL, which the bridge stream-proxies
straight to Sonos — same path as podcast enclosures.

## Endpoints (JSON, consumed by the bridge)

- `GET /info` — descriptor (`capabilities: ["search", "pin"]`).
- `GET /browse?id=` — root (pinned stations + the TuneIn directory: Local Radio,
  Music, Talk, Sports, By Location, …), or a directory node's contents.
- `GET /search?q=` — stations and shows matching the query.
- `GET /track?id=` — resolve a station to its best stream URL + metadata.
- `GET /subscriptions` — encoded ids of pinned stations.
- `POST /pin` / `POST /unpin` — body `{ "id": "<station id>" }`.

## Config (env)

| Var | Default | Notes |
|-----|---------|-------|
| `MISONOS_TUNEIN_PORT` | `4324` | HTTP port |
| `MISONOS_TUNEIN_DB` | `~/.misonos/tunein.db` | pinned-stations SQLite |
| `MISONOS_TUNEIN_PARTNER_ID` / `MISONOS_TUNEIN_SERIAL` | — | optional TuneIn partner credentials; appended to requests when set |

Pinned stations persist in the SQLite DB and appear first under the root browse.
Browse/station ids are self-describing (a directory node carries its TuneIn URL, a
station carries its `guide_id` plus name/art), so the source holds no resolution
state beyond your favorites.

## Notes & limitations

- **Live radio has no per-track metadata**, so "now playing" stays at the station
  name + logo; there is no duration.
- `Tune.ashx` usually returns a direct MP3/AAC stream (proxied like any podcast
  enclosure). It can also return non-direct **playlist** wrappers (`.pls`/`.m3u`)
  or **HLS** streams; those sort last and may need an extra unwrap before the
  bridge proxy can play them.
- Browse currently **flattens** TuneIn's group headers (e.g. "Local Stations (12)")
  so stations surface inline; surfacing those as section headers would be a nice
  follow-up.
