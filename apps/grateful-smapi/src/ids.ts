export type GratefulId =
  | { kind: "root" }
  | { kind: "years" }
  | { kind: "venues" }
  | { kind: "songs" }
  | { kind: "year"; year: string }
  | { kind: "venue"; venueId: string }
  | { kind: "song"; songId: string }
  | { kind: "concert"; concertId: string }
  | { kind: "recording"; recordingId: string }
  | { kind: "track"; recordingId: string; trackNumber: number };

const PREFIX = {
  root: "root",
  years: "years",
  venues: "venues",
  songs: "songs",
  year: "y",
  venue: "v",
  song: "s",
  concert: "c",
  recording: "r",
  track: "t"
} as const;

export function encodeId(id: GratefulId): string {
  switch (id.kind) {
    case "root": return PREFIX.root;
    case "years": return PREFIX.years;
    case "venues": return PREFIX.venues;
    case "songs": return PREFIX.songs;
    case "year": return `${PREFIX.year}:${id.year}`;
    case "venue": return `${PREFIX.venue}:${id.venueId}`;
    case "song": return `${PREFIX.song}:${id.songId}`;
    case "concert": return `${PREFIX.concert}:${id.concertId}`;
    case "recording": return `${PREFIX.recording}:${id.recordingId}`;
    case "track": return `${PREFIX.track}:${id.recordingId}:${id.trackNumber}`;
  }
}

export function decodeId(raw: string): GratefulId {
  if (raw === PREFIX.root) return { kind: "root" };
  if (raw === PREFIX.years) return { kind: "years" };
  if (raw === PREFIX.venues) return { kind: "venues" };
  if (raw === PREFIX.songs) return { kind: "songs" };

  const colon = raw.indexOf(":");
  if (colon < 0) throw new Error(`Unknown id: ${raw}`);
  const prefix = raw.slice(0, colon);
  const rest = raw.slice(colon + 1);

  switch (prefix) {
    case PREFIX.year:
      return { kind: "year", year: rest };
    case PREFIX.venue:
      return { kind: "venue", venueId: rest };
    case PREFIX.song:
      return { kind: "song", songId: rest };
    case PREFIX.concert:
      return { kind: "concert", concertId: rest };
    case PREFIX.recording:
      return { kind: "recording", recordingId: rest };
    case PREFIX.track: {
      const lastColon = rest.lastIndexOf(":");
      if (lastColon < 0) throw new Error(`Bad track id: ${raw}`);
      const recordingId = rest.slice(0, lastColon);
      const trackNumber = Number.parseInt(rest.slice(lastColon + 1), 10);
      if (Number.isNaN(trackNumber)) throw new Error(`Bad track number in id: ${raw}`);
      return { kind: "track", recordingId, trackNumber };
    }
    default:
      throw new Error(`Unknown id prefix: ${prefix}`);
  }
}
