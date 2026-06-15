import { ArchiveClient, type Item, type Track } from "./archive.js";
import { decodeId, encodeId, type LmaId } from "./ids.js";
import { escapeXml, extractTagInt, extractTagText, soapResponse, soapFault } from "./soap.js";

export interface SmapiContext {
  client: ArchiveClient;
  catalogVersion: string;
}

export interface BrowseItem {
  id: string;
  title: string;
  type: "container" | "album" | "track";
  subtitle?: string;
  album?: string;
  artist?: string;
  durationSeconds?: number;
  mimeType?: string;
  albumArtUri?: string;
}

// Every archive.org item exposes a predictable auto-generated thumbnail.
export function archiveThumbUrl(itemId: string): string {
  return `https://archive.org/download/${encodeURIComponent(itemId)}/__ia_thumb.jpg`;
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const DEFAULT_COUNT = 100;

export async function dispatch(action: string, body: string, ctx: SmapiContext): Promise<{ body: string; status: number }> {
  try {
    switch (action) {
      case "getLastUpdate":
        return ok(handleGetLastUpdate(ctx));
      case "getMetadata":
        return ok(await handleGetMetadata(body, ctx));
      case "getMediaMetadata":
        return ok(await handleGetMediaMetadata(body, ctx));
      case "getMediaURI":
        return ok(await handleGetMediaURI(body, ctx));
      case "getSessionId":
        return soapFault("LoginUnsupported", "Anonymous service");
      case "search":
        return ok(soapResponse("search", emptyResult("searchResult")));
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
    `<pollInterval>3600</pollInterval>` +
    `</getLastUpdateResult>`;
  return soapResponse("getLastUpdate", inner);
}

async function handleGetMetadata(body: string, ctx: SmapiContext): Promise<string> {
  const rawId = extractTagText(body, "id") ?? "root";
  const index = extractTagInt(body, "index", 0);
  const count = extractTagInt(body, "count", DEFAULT_COUNT);
  const id = decodeId(rawId);
  const { total, items } = await browse(id, index, count, ctx);
  const inner =
    `<getMetadataResult>` +
    `<index>${index}</index>` +
    `<count>${items.length}</count>` +
    `<total>${total}</total>` +
    items.map(renderItem).join("") +
    `</getMetadataResult>`;
  return soapResponse("getMetadata", inner);
}

async function handleGetMediaMetadata(body: string, ctx: SmapiContext): Promise<string> {
  const rawId = extractTagText(body, "id") ?? "";
  const { item, track } = await resolveTrack(rawId, ctx);
  const inner = `<getMediaMetadataResult>${renderTrackMetadata(rawId, item, track)}</getMediaMetadataResult>`;
  return soapResponse("getMediaMetadata", inner);
}

async function handleGetMediaURI(body: string, ctx: SmapiContext): Promise<string> {
  const rawId = extractTagText(body, "id") ?? "";
  const { item, track } = await resolveTrack(rawId, ctx);
  const url = ctx.client.trackUrl(item.id, track.filename);
  const inner = `<getMediaURIResult>${escapeXml(url)}</getMediaURIResult>`;
  return soapResponse("getMediaURI", inner);
}

async function resolveTrack(rawId: string, ctx: SmapiContext): Promise<{ item: Item; track: Track }> {
  const id = decodeId(rawId);
  if (id.kind !== "track") throw new Error("Not a track id");
  const item = await ctx.client.item(id.itemId);
  const track = item.tracks.find((t) => t.fileIndex === id.fileIndex);
  if (!track) throw new Error("Track not found");
  return { item, track };
}

export async function browse(id: LmaId, index: number, count: number, ctx: SmapiContext): Promise<{ total: number; items: BrowseItem[] }> {
  switch (id.kind) {
    case "root":
      return page([
        container(encodeId({ kind: "popular" }), "Popular Bands"),
        container(encodeId({ kind: "bandsAz" }), "Bands A–Z")
      ], index, count);

    case "bandsAz":
      return page(LETTERS.map((letter) => container(encodeId({ kind: "letter", letter }), letter)), index, count);

    case "popular": {
      const { total, bands } = await ctx.client.popularBands(index, count);
      return { total, items: bands.map((band) => container(encodeId({ kind: "band", bandId: band.id }), band.title)) };
    }

    case "letter": {
      const { total, bands } = await ctx.client.bandsByLetter(id.letter, index, count);
      return { total, items: bands.map((band) => container(encodeId({ kind: "band", bandId: band.id }), band.title)) };
    }

    case "band": {
      const children: BrowseItem[] = [
        container(encodeId({ kind: "bandAll", bandId: id.bandId }), "All Recordings (by date)")
      ];
      const range = await ctx.client.bandYearRange(id.bandId);
      if (range) {
        for (let year = range.max; year >= range.min; year--) {
          children.push(container(encodeId({ kind: "bandYear", bandId: id.bandId, year: String(year) }), String(year)));
        }
      }
      return page(children, index, count);
    }

    case "bandAll": {
      const { total, recordings } = await ctx.client.recordings(id.bandId, index, count);
      return { total, items: recordings.map(recordingItem) };
    }

    case "bandYear": {
      const { total, recordings } = await ctx.client.recordings(id.bandId, index, count, id.year);
      return { total, items: recordings.map(recordingItem) };
    }

    case "item": {
      const item = await ctx.client.item(id.itemId);
      const album = showLabel(item.date, item.venue);
      const itemArt = archiveThumbUrl(item.id);
      const items = item.tracks.map((track) => ({
        id: encodeId({ kind: "track", itemId: item.id, fileIndex: track.fileIndex }),
        title: track.title,
        type: "track" as const,
        artist: item.artist,
        album,
        durationSeconds: track.durationSeconds,
        mimeType: "audio/mpeg",
        albumArtUri: itemArt
      }));
      return page(items, index, count);
    }

    case "track":
      throw new Error("Tracks are leaves, not browsable");
  }
}

function recordingItem(recording: { id: string; date: string; venue: string; artist?: string }): BrowseItem {
  return {
    id: encodeId({ kind: "item", itemId: recording.id }),
    title: showLabel(recording.date, recording.venue),
    type: "album",
    subtitle: recording.venue || undefined,
    artist: recording.artist || undefined,
    albumArtUri: archiveThumbUrl(recording.id)
  };
}

function container(id: string, title: string, subtitle?: string): BrowseItem {
  return { id, title, type: "container", subtitle };
}

/** Slice an already-materialized list to the requested SMAPI window. */
function page(items: BrowseItem[], index: number, count: number): { total: number; items: BrowseItem[] } {
  return { total: items.length, items: items.slice(index, index + count) };
}

function showLabel(date: string, venue: string): string {
  if (!date) return venue || "Unknown date";
  if (!venue) return date;
  return `${date} — ${venue}`;
}

function emptyResult(tag: string): string {
  return `<${tag}><index>0</index><count>0</count><total>0</total></${tag}>`;
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

function renderTrackMetadata(rawId: string, item: Item, track: Track): string {
  return `<mediaMetadata>` +
    `<id>${escapeXml(rawId)}</id>` +
    `<itemType>track</itemType>` +
    `<title>${escapeXml(track.title)}</title>` +
    `<mimeType>audio/mpeg</mimeType>` +
    `<trackMetadata>` +
    `<artist>${escapeXml(item.artist)}</artist>` +
    `<album>${escapeXml(showLabel(item.date, item.venue))}</album>` +
    `<duration>${track.durationSeconds}</duration>` +
    `</trackMetadata>` +
    `</mediaMetadata>`;
}
