export type PhishId =
  | { kind: "root" }
  | { kind: "years" }
  | { kind: "songs" }
  | { kind: "venues" }
  | { kind: "tours" }
  | { kind: "year"; year: string }
  | { kind: "song"; songId: string }
  | { kind: "venue"; venueId: string }
  | { kind: "tour"; tourId: string }
  | { kind: "show"; showId: string }
  | { kind: "track"; trackId: string };

const PREFIX = {
  root: "root",
  years: "years",
  songs: "songs",
  venues: "venues",
  tours: "tours",
  year: "y",
  song: "s",
  venue: "v",
  tour: "tr",
  show: "sh",
  track: "t"
} as const;

export function encodeId(id: PhishId): string {
  switch (id.kind) {
    case "root": return PREFIX.root;
    case "years": return PREFIX.years;
    case "songs": return PREFIX.songs;
    case "venues": return PREFIX.venues;
    case "tours": return PREFIX.tours;
    case "year": return `${PREFIX.year}:${id.year}`;
    case "song": return `${PREFIX.song}:${id.songId}`;
    case "venue": return `${PREFIX.venue}:${id.venueId}`;
    case "tour": return `${PREFIX.tour}:${id.tourId}`;
    case "show": return `${PREFIX.show}:${id.showId}`;
    case "track": return `${PREFIX.track}:${id.trackId}`;
  }
}

export function decodeId(raw: string): PhishId {
  if (raw === PREFIX.root) return { kind: "root" };
  if (raw === PREFIX.years) return { kind: "years" };
  if (raw === PREFIX.songs) return { kind: "songs" };
  if (raw === PREFIX.venues) return { kind: "venues" };
  if (raw === PREFIX.tours) return { kind: "tours" };
  const colon = raw.indexOf(":");
  if (colon < 0) throw new Error(`Unknown id: ${raw}`);
  const prefix = raw.slice(0, colon);
  const rest = raw.slice(colon + 1);
  switch (prefix) {
    case PREFIX.year: return { kind: "year", year: rest };
    case PREFIX.song: return { kind: "song", songId: rest };
    case PREFIX.venue: return { kind: "venue", venueId: rest };
    case PREFIX.tour: return { kind: "tour", tourId: rest };
    case PREFIX.show: return { kind: "show", showId: rest };
    case PREFIX.track: return { kind: "track", trackId: rest };
    default: throw new Error(`Unknown id prefix: ${prefix}`);
  }
}
