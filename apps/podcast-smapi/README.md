# @misonos/podcast-smapi

A MiSonos source server for podcasts. Discovery via **Podcast Index** (free key) with
an **Apple Podcasts** (iTunes, key-free) fallback; episodes, durations, artwork and the
playable enclosure URL all come from the show's **RSS feed**. Because enclosures are
plain HTTP audio, the bridge stream-proxies them straight to Sonos — no DRM/PO-token
issues.

## Endpoints (JSON, consumed by the bridge)

- `GET /info` — descriptor (`capabilities: ["search", "pin"]`).
- `GET /browse?id=` — root (New Episodes + pinned shows), a show's episodes, or the
  merged New Episodes feed.
- `GET /search?q=` — shows matching the query.
- `GET /track?id=` — resolve an episode to its enclosure URL + metadata.
- `GET /subscriptions` — encoded ids of pinned shows.
- `POST /pin` / `POST /unpin` — body `{ "id": "<show id>" }`.

## Config (env)

| Var | Default | Notes |
|-----|---------|-------|
| `MISONOS_PODCAST_PORT` | `4323` | HTTP port |
| `MISONOS_PODCAST_DB` | `~/.misonos/podcasts.db` | pinned-shows SQLite |
| `PODCASTINDEX_KEY` / `PODCASTINDEX_SECRET` | — | enable Podcast Index search (free at api.podcastindex.org); falls back to iTunes when unset |

Pinned shows persist in the SQLite DB; "New Episodes" merges the most recent items
across them.
