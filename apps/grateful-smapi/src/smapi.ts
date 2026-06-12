import { GratefulDb, trackUrl, trackDurationSeconds, type TrackRow } from "./db.js";
import { decodeId, encodeId, type GratefulId } from "./ids.js";
import { escapeXml, extractTagInt, extractTagText, soapResponse, soapFault } from "./soap.js";

export interface SmapiContext {
  db: GratefulDb;
  catalogVersion: string;
}

export function dispatch(action: string, body: string, ctx: SmapiContext): { body: string; status: number } {
  try {
    switch (action) {
      case "getLastUpdate":
        return ok(handleGetLastUpdate(ctx));
      case "getMetadata":
        return ok(handleGetMetadata(body, ctx));
      case "getMediaMetadata":
        return ok(handleGetMediaMetadata(body, ctx));
      case "getMediaURI":
        return ok(handleGetMediaURI(body, ctx));
      case "getSessionId":
        return soapFault("LoginUnsupported", "Anonymous service");
      case "search":
        return ok(soapResponse("search", searchPlaceholder()));
      default:
        return soapFault("ItemNotFound", `Unsupported SMAPI action: ${action}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal error";
    return soapFault("ItemNotFound", message);
  }
}

function ok(body: string): { body: string; status: number } {
  return { body, status: 200 };
}

function handleGetLastUpdate(ctx: SmapiContext): string {
  const inner =
    `<getLastUpdateResult>` +
    `<catalog>${escapeXml(ctx.catalogVersion)}</catalog>` +
    `<favorites>0</favorites>` +
    `<pollInterval>30</pollInterval>` +
    `</getLastUpdateResult>`;
  return soapResponse("getLastUpdate", inner);
}

function handleGetMetadata(body: string, ctx: SmapiContext): string {
  const rawId = extractTagText(body, "id") ?? "root";
  const index = extractTagInt(body, "index", 0);
  const count = extractTagInt(body, "count", 100);
  const id = decodeId(rawId);
  const { total, items } = browse(id, ctx);
  const slice = items.slice(index, index + count);
  const inner =
    `<getMetadataResult>` +
    `<index>${index}</index>` +
    `<count>${slice.length}</count>` +
    `<total>${total}</total>` +
    slice.map(renderItem).join("") +
    `</getMetadataResult>`;
  return soapResponse("getMetadata", inner);
}

function handleGetMediaMetadata(body: string, ctx: SmapiContext): string {
  const rawId = extractTagText(body, "id") ?? "";
  const id = decodeId(rawId);
  if (id.kind !== "track") {
    throw new Error("Not a track id");
  }
  const track = ctx.db.track(id.recordingId, id.trackNumber);
  if (!track) throw new Error("Track not found");
  const inner = `<getMediaMetadataResult>${renderTrackMetadata(track)}</getMediaMetadataResult>`;
  return soapResponse("getMediaMetadata", inner);
}

function handleGetMediaURI(body: string, ctx: SmapiContext): string {
  const rawId = extractTagText(body, "id") ?? "";
  const id = decodeId(rawId);
  if (id.kind !== "track") {
    throw new Error("Not a track id");
  }
  const track = ctx.db.track(id.recordingId, id.trackNumber);
  if (!track) throw new Error("Track not found");
  const url = trackUrl(track);
  if (!url) throw new Error("Track has no playable URL");
  const inner = `<getMediaURIResult>${escapeXml(url)}</getMediaURIResult>`;
  return soapResponse("getMediaURI", inner);
}

function searchPlaceholder(): string {
  return `<searchResult><index>0</index><count>0</count><total>0</total></searchResult>`;
}

export interface BrowseItem {
  id: string;
  title: string;
  type: "container" | "album" | "track";
  album?: string;
  artist?: string;
  durationSeconds?: number;
  mimeType?: string;
}

export function browse(id: GratefulId, ctx: SmapiContext): { total: number; items: BrowseItem[] } {
  switch (id.kind) {
    case "root":
      return staticContainers([
        { id: encodeId({ kind: "years" }), title: "By Year" },
        { id: encodeId({ kind: "venues" }), title: "By Venue" },
        { id: encodeId({ kind: "songs" }), title: "By Song" }
      ]);
    case "years": {
      const years = ctx.db.listYears();
      return listed(years.map((row) => ({
        id: encodeId({ kind: "year", year: row.year }),
        title: `${row.year} (${row.count} concerts)`,
        type: "container" as const
      })));
    }
    case "venues": {
      const venues = ctx.db.listVenues();
      return listed(venues.map((row) => ({
        id: encodeId({ kind: "venue", venueId: row.id }),
        title: `${row.title} (${row.count})`,
        type: "container" as const
      })));
    }
    case "songs": {
      const songs = ctx.db.listSongs();
      return listed(songs.map((row) => ({
        id: encodeId({ kind: "song", songId: row.id }),
        title: row.title,
        type: "container" as const
      })));
    }
    case "year": {
      const concerts = ctx.db.concertsByYear(id.year);
      return listed(concerts.map((row) => ({
        id: encodeId({ kind: "concert", concertId: row.id }),
        title: concertLabel(row.date, row.venueTitle),
        type: "container" as const
      })));
    }
    case "venue": {
      const concerts = ctx.db.concertsByVenue(id.venueId);
      return listed(concerts.map((row) => ({
        id: encodeId({ kind: "concert", concertId: row.id }),
        title: row.date,
        type: "container" as const
      })));
    }
    case "song": {
      const concerts = ctx.db.concertsBySong(id.songId);
      return listed(concerts.map((row) => ({
        id: encodeId({ kind: "concert", concertId: row.id }),
        title: concertLabel(row.date, row.venueTitle),
        type: "container" as const
      })));
    }
    case "concert": {
      const recordings = ctx.db.recordingsByConcert(id.concertId);
      return listed(recordings.map((row) => ({
        id: encodeId({ kind: "recording", recordingId: row.id }),
        title: row.title,
        type: "album" as const
      })));
    }
    case "recording": {
      const tracks = ctx.db.tracksByRecording(id.recordingId);
      const playable = tracks.filter((track) => trackUrl(track));
      return listed(playable.map((row) => ({
        id: encodeId({ kind: "track", recordingId: row.recordingId, trackNumber: row.trackNumber }),
        title: row.title || `Track ${row.trackNumber + 1}`,
        type: "track" as const,
        album: concertLabel(row.date, row.venueTitle),
        artist: "Grateful Dead",
        durationSeconds: trackDurationSeconds(row.duration),
        mimeType: "audio/mpeg"
      })));
    }
    case "track":
      throw new Error("Tracks are leaves, not browsable");
  }
}

function staticContainers(items: { id: string; title: string }[]): { total: number; items: BrowseItem[] } {
  return listed(items.map((item) => ({ ...item, type: "container" as const })));
}

function listed(items: BrowseItem[]): { total: number; items: BrowseItem[] } {
  return { total: items.length, items };
}

function concertLabel(date: string, venueTitle: string): string {
  if (!date) return venueTitle || "Unknown date";
  if (!venueTitle) return date;
  return `${date} — ${venueTitle}`;
}

function renderItem(item: BrowseItem): string {
  if (item.type === "track") {
    return `<mediaMetadata>` +
      `<id>${escapeXml(item.id)}</id>` +
      `<itemType>track</itemType>` +
      `<title>${escapeXml(item.title)}</title>` +
      `<mimeType>${escapeXml(item.mimeType ?? "audio/mpeg")}</mimeType>` +
      `<trackMetadata>` +
      (item.artist ? `<artist>${escapeXml(item.artist)}</artist>` : "") +
      (item.album ? `<album>${escapeXml(item.album)}</album>` : "") +
      `<duration>${item.durationSeconds ?? 0}</duration>` +
      `</trackMetadata>` +
      `</mediaMetadata>`;
  }
  return `<mediaCollection>` +
    `<id>${escapeXml(item.id)}</id>` +
    `<itemType>${item.type}</itemType>` +
    `<title>${escapeXml(item.title)}</title>` +
    `<canPlay>${item.type === "album" ? "true" : "false"}</canPlay>` +
    `</mediaCollection>`;
}

function renderTrackMetadata(track: TrackRow): string {
  return `<mediaMetadata>` +
    `<id>${escapeXml(encodeId({ kind: "track", recordingId: track.recordingId, trackNumber: track.trackNumber }))}</id>` +
    `<itemType>track</itemType>` +
    `<title>${escapeXml(track.title || `Track ${track.trackNumber + 1}`)}</title>` +
    `<mimeType>audio/mpeg</mimeType>` +
    `<trackMetadata>` +
    `<artist>Grateful Dead</artist>` +
    `<album>${escapeXml(concertLabel(track.date, track.venueTitle))}</album>` +
    `<duration>${trackDurationSeconds(track.duration)}</duration>` +
    `</trackMetadata>` +
    `</mediaMetadata>`;
}
