export type YtmId =
  | { kind: "root" }
  | { kind: "search-songs" }
  | { kind: "search-artists" }
  | { kind: "search-albums" }
  | { kind: "search"; query: string }
  | { kind: "home" }
  | { kind: "new-releases" }
  | { kind: "charts" }
  | { kind: "library" }
  | { kind: "library-playlists" }
  | { kind: "library-liked" }
  | { kind: "library-songs" }
  | { kind: "library-albums" }
  | { kind: "library-artists" }
  | { kind: "library-subscriptions" }
  | { kind: "library-podcasts" }
  | { kind: "library-history" }
  | { kind: "supermix" }
  | { kind: "artist"; channelId: string }
  | { kind: "album"; browseId: string }
  | { kind: "playlist"; playlistId: string }
  | { kind: "track"; videoId: string };

const SIMPLE: Record<string, YtmId["kind"]> = {
  "root": "root",
  "search-songs": "search-songs",
  "search-artists": "search-artists",
  "search-albums": "search-albums",
  "home": "home",
  "new-releases": "new-releases",
  "charts": "charts",
  "library": "library",
  "library-playlists": "library-playlists",
  "library-liked": "library-liked",
  "library-songs": "library-songs",
  "library-albums": "library-albums",
  "library-artists": "library-artists",
  "library-subscriptions": "library-subscriptions",
  "library-podcasts": "library-podcasts",
  "library-history": "library-history",
  "supermix": "supermix"
};

export function encodeId(id: YtmId): string {
  switch (id.kind) {
    case "search": return `search:${encodeURIComponent(id.query)}`;
    case "artist": return `artist:${id.channelId}`;
    case "album": return `album:${id.browseId}`;
    case "playlist": return `playlist:${id.playlistId}`;
    case "track": return `t:${id.videoId}`;
    default: return id.kind;
  }
}

export function decodeId(raw: string): YtmId {
  if (raw in SIMPLE) return { kind: SIMPLE[raw] } as YtmId;
  if (raw.startsWith("search:")) return { kind: "search", query: decodeURIComponent(raw.slice(7)) };
  if (raw.startsWith("artist:")) return { kind: "artist", channelId: raw.slice(7) };
  if (raw.startsWith("album:")) return { kind: "album", browseId: raw.slice(6) };
  if (raw.startsWith("playlist:")) return { kind: "playlist", playlistId: raw.slice(9) };
  if (raw.startsWith("t:")) return { kind: "track", videoId: raw.slice(2) };
  throw new Error(`Unknown id: ${raw}`);
}
