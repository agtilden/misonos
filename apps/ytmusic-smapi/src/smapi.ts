import { decodeId, encodeId } from "./ids.js";
import { getStreamUrl } from "./client.js";
import { getTrackInfo } from "./ytmApi.js";
import { escapeXml, extractTagText, soapResponse, soapFault } from "./soap.js";

export async function dispatch(action: string, body: string): Promise<{ body: string; status: number }> {
  try {
    switch (action) {
      case "getLastUpdate":
        return ok(handleGetLastUpdate());
      case "getMetadata":
        return ok(handleGetMetadata());
      case "getMediaMetadata":
        return ok(await handleGetMediaMetadata(body));
      case "getMediaURI":
        return ok(await handleGetMediaURI(body));
      case "getSessionId":
        return soapFault("LoginUnsupported", "Anonymous service");
      case "search":
        return ok(soapResponse("search", `<searchResult><index>0</index><count>0</count><total>0</total></searchResult>`));
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

function handleGetLastUpdate(): string {
  // Catalog is dynamic (search-driven) so just bump catalog version constantly.
  const inner =
    `<getLastUpdateResult>` +
    `<catalog>${Date.now()}</catalog>` +
    `<favorites>0</favorites>` +
    `<pollInterval>3600</pollInterval>` +
    `</getLastUpdateResult>`;
  return soapResponse("getLastUpdate", inner);
}

function handleGetMetadata(): string {
  // The official Sonos app should not be used to browse this service — MiSonos
  // owns browse. Return an empty root container so the app shows nothing useful
  // but doesn't error out.
  const inner =
    `<getMetadataResult>` +
    `<index>0</index>` +
    `<count>0</count>` +
    `<total>0</total>` +
    `</getMetadataResult>`;
  return soapResponse("getMetadata", inner);
}

async function handleGetMediaMetadata(body: string): Promise<string> {
  const rawId = extractTagText(body, "id") ?? "";
  const id = decodeId(rawId);
  if (id.kind !== "track") throw new Error("Not a track id");
  const meta = await getTrackInfo(id.videoId);
  const title = meta?.title ?? id.videoId;
  const artist = meta?.artist ?? "";
  const album = meta?.album ?? "";
  const duration = meta?.durationSeconds ?? 0;
  const albumArt = meta?.thumbnailUrl ?? "";
  const inner =
    `<getMediaMetadataResult>` +
    `<mediaMetadata>` +
    `<id>${escapeXml(encodeId({ kind: "track", videoId: id.videoId }))}</id>` +
    `<itemType>track</itemType>` +
    `<title>${escapeXml(title)}</title>` +
    `<mimeType>audio/mp4</mimeType>` +
    `<trackMetadata>` +
    (artist ? `<artist>${escapeXml(artist)}</artist>` : "") +
    (album ? `<album>${escapeXml(album)}</album>` : "") +
    (albumArt ? `<albumArtURI>${escapeXml(albumArt)}</albumArtURI>` : "") +
    `<duration>${duration}</duration>` +
    `<canPlay>true</canPlay>` +
    `</trackMetadata>` +
    `</mediaMetadata>` +
    `</getMediaMetadataResult>`;
  return soapResponse("getMediaMetadata", inner);
}

async function handleGetMediaURI(body: string): Promise<string> {
  const rawId = extractTagText(body, "id") ?? "";
  const id = decodeId(rawId);
  if (id.kind !== "track") throw new Error("Not a track id");
  const stream = await getStreamUrl(id.videoId);
  const inner =
    `<getMediaURIResult>${escapeXml(stream.url)}</getMediaURIResult>` +
    `<httpHeaders>` +
    `<httpHeader>` +
    `<header>User-Agent</header>` +
    `<value>Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36</value>` +
    `</httpHeader>` +
    `</httpHeaders>`;
  return soapResponse("getMediaURI", inner);
}
