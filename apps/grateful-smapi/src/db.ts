import Database from "better-sqlite3";

export interface YearRow { year: string; count: number }
export interface VenueRow { id: string; title: string; count: number }
export interface SongRow { id: string; title: string }
export interface ConcertRow { id: string; date: string; venueTitle: string; albumArt: string }
export interface RecordingRow { id: string; title: string; albumArt: string }
export interface TrackRow {
  recordingId: string;
  trackNumber: number;
  title: string;
  duration: string;
  mp3: string;
  server: string;
  maindir: string;
  date: string;
  venueTitle: string;
  albumArt: string;
}

export class GratefulDb {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path, { readonly: true, fileMustExist: true });
  }

  close(): void {
    this.db.close();
  }

  listYears(): YearRow[] {
    const rows = this.db.prepare(
      "SELECT substr(date, 1, 4) AS year, COUNT(*) AS count FROM concert WHERE date IS NOT NULL AND date != '' GROUP BY year ORDER BY year"
    ).all() as { year: string; count: number }[];
    return rows;
  }

  listVenues(): VenueRow[] {
    return this.db.prepare(
      "SELECT v.id AS id, v.title AS title, COUNT(c.id) AS count " +
      "FROM venue v LEFT JOIN concert c ON c.venue_id = v.id " +
      "GROUP BY v.id, v.title ORDER BY v.title"
    ).all() as VenueRow[];
  }

  listSongs(): SongRow[] {
    return this.db.prepare(
      "SELECT id, title FROM song ORDER BY title"
    ).all() as SongRow[];
  }

  concertsByYear(year: string): ConcertRow[] {
    return this.db.prepare(
      "SELECT c.id AS id, c.date AS date, COALESCE(v.title, '') AS venueTitle, COALESCE(ci.url, '') AS albumArt " +
      "FROM concert c LEFT JOIN venue v ON v.id = c.venue_id " +
      "LEFT JOIN concert_image ci ON ci.concert_id = c.id " +
      "WHERE substr(c.date, 1, 4) = ? ORDER BY c.date"
    ).all(year) as ConcertRow[];
  }

  concertsByVenue(venueId: string): ConcertRow[] {
    return this.db.prepare(
      "SELECT c.id AS id, c.date AS date, COALESCE(v.title, '') AS venueTitle, COALESCE(ci.url, '') AS albumArt " +
      "FROM concert c LEFT JOIN venue v ON v.id = c.venue_id " +
      "LEFT JOIN concert_image ci ON ci.concert_id = c.id " +
      "WHERE c.venue_id = ? ORDER BY c.date"
    ).all(venueId) as ConcertRow[];
  }

  concertsBySong(songId: string): ConcertRow[] {
    // setlist.song_id is resolved from canonical song titles at build time
    // (see https://github.com/agtilden/grateful-dead-db), so filter by it
    // directly via the idx_setlist_song index.
    return this.db.prepare(
      "SELECT DISTINCT c.id AS id, c.date AS date, COALESCE(v.title, '') AS venueTitle, COALESCE(ci.url, '') AS albumArt " +
      "FROM setlist s " +
      "JOIN recording r ON r.id = s.recording_id " +
      "JOIN concert c ON c.id = r.concert_id " +
      "LEFT JOIN venue v ON v.id = c.venue_id " +
      "LEFT JOIN concert_image ci ON ci.concert_id = c.id " +
      "WHERE s.song_id = ? ORDER BY c.date"
    ).all(songId) as ConcertRow[];
  }

  recordingsByConcert(concertId: string): RecordingRow[] {
    return this.db.prepare(
      "SELECT r.id AS id, COALESCE(rs.title, r.id) AS title, COALESCE(ci.url, '') AS albumArt " +
      "FROM recording r LEFT JOIN recording_stream rs ON rs.recording_id = r.id " +
      "LEFT JOIN concert_image ci ON ci.concert_id = r.concert_id " +
      "WHERE r.concert_id = ? ORDER BY r.id"
    ).all(concertId) as RecordingRow[];
  }

  tracksByRecording(recordingId: string): TrackRow[] {
    return this.db.prepare(
      "SELECT s.tracknumber AS trackNumber, s.title AS title, s.duration AS duration, s.mp3 AS mp3, " +
      "       rs.server AS server, rs.maindir AS maindir, c.date AS date, COALESCE(v.title, '') AS venueTitle, " +
      "       s.recording_id AS recordingId, COALESCE(ci.url, '') AS albumArt " +
      "FROM setlist s " +
      "JOIN recording r ON r.id = s.recording_id " +
      "JOIN concert c ON c.id = r.concert_id " +
      "LEFT JOIN venue v ON v.id = c.venue_id " +
      "LEFT JOIN recording_stream rs ON rs.recording_id = r.id " +
      "LEFT JOIN concert_image ci ON ci.concert_id = c.id " +
      "WHERE s.recording_id = ? ORDER BY s.tracknumber"
    ).all(recordingId) as TrackRow[];
  }

  track(recordingId: string, trackNumber: number): TrackRow | undefined {
    return this.db.prepare(
      "SELECT s.tracknumber AS trackNumber, s.title AS title, s.duration AS duration, s.mp3 AS mp3, " +
      "       rs.server AS server, rs.maindir AS maindir, c.date AS date, COALESCE(v.title, '') AS venueTitle, " +
      "       s.recording_id AS recordingId, COALESCE(ci.url, '') AS albumArt " +
      "FROM setlist s " +
      "JOIN recording r ON r.id = s.recording_id " +
      "JOIN concert c ON c.id = r.concert_id " +
      "LEFT JOIN venue v ON v.id = c.venue_id " +
      "LEFT JOIN recording_stream rs ON rs.recording_id = r.id " +
      "LEFT JOIN concert_image ci ON ci.concert_id = c.id " +
      "WHERE s.recording_id = ? AND s.tracknumber = ?"
    ).get(recordingId, trackNumber) as TrackRow | undefined;
  }

  venueTitle(venueId: string): string | undefined {
    const row = this.db.prepare("SELECT title FROM venue WHERE id = ?").get(venueId) as { title: string } | undefined;
    return row?.title;
  }

  songTitle(songId: string): string | undefined {
    const row = this.db.prepare("SELECT title FROM song WHERE id = ?").get(songId) as { title: string } | undefined;
    return row?.title;
  }
}

export function trackUrl(track: TrackRow): string | null {
  if (!track.mp3 || !track.recordingId) return null;
  // archive.org's canonical /download/ path 302-redirects to the current CDN server.
  // The historical (server, maindir) pair gets stale because archive.org rotates hostnames.
  return `https://archive.org/download/${encodeURIComponent(track.recordingId)}/${encodeURIComponent(track.mp3)}`;
}

// Tokens that describe the file/format, not the lineage — skipped when picking a
// taper name out of a recording id.
const FORMAT_TOKENS = new Set([
  "shnf", "shn", "flac", "flac16", "flac24", "flac2496", "sbeok", "sbefail", "vbr",
  "fix", "mtx16", "16", "24", "2496", "unknown"
]);

function classifySource(token: string): string {
  const t = token.toLowerCase();
  if (t.includes("matrix") || t.includes("mtx")) return "Matrix";
  if (t.includes("sbd")) return "Soundboard"; // covers sbd, dsbd, sbd-set2, ...
  if (t === "fm") return "FM broadcast";
  if (t === "aud" || t === "fob") return "Audience";
  // A microphone brand as the source token means it's an audience tape.
  if (/^(nak|schoeps|senn|sennheiser|akg|beyer|neumann|sony|sonyecm)/.test(t)) return "Audience";
  return token ? token.toUpperCase() : "Recording";
}

// Derive a human, distinguishing label from a recording id. Archive.org gives every
// recording of a show the same item title ("Grateful Dead Live at <venue> on <date>"),
// so the soundboard and the audience tapes are only told apart by the id, which looks
// like gd<date>.<source>.<taper>.<...>.<format> — e.g. gd1974-03-23.sbd.clugston-orf...
export function recordingLabel(id: string): string {
  const tokens = id.split(".");
  const source = classifySource(tokens[1] ?? "");
  const lineage = tokens.slice(2).find(
    (tok) => tok && !/^\d+$/.test(tok) && !FORMAT_TOKENS.has(tok.toLowerCase())
  );
  return lineage ? `${source} · ${lineage}` : source;
}

export function trackDurationSeconds(value: string | undefined): number {
  if (!value) return 0;
  const parts = value.split(":").map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => Number.isNaN(part))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return 0;
}
