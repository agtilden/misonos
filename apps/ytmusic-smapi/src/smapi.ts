import { networkInterfaces } from "node:os";
import { decodeId, encodeId } from "./ids.js";
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
  // S1 hardware (ZP100 era) can't reliably fetch googlevideo HTTPS URLs, so
  // hand Sonos the bridge's plain-HTTP stream proxy instead of the raw URL.
  const inner = `<getMediaURIResult>${escapeXml(bridgeStreamUrl(id.videoId))}</getMediaURIResult>`;
  return soapResponse("getMediaURI", inner);
}

function bridgeStreamUrl(videoId: string): string {
  // The stream URL is fetched by the Sonos speaker, so it must be a LAN address
  // the speaker can reach. Honor MISONOS_STREAM_BASE, then the bridge's own
  // public-host override (same var the bridge uses for its stream proxy), and
  // only then fall back to interface auto-detection.
  const host = process.env.MISONOS_BRIDGE_PUBLIC_HOST ?? detectLanIp() ?? "127.0.0.1";
  const base = process.env.MISONOS_STREAM_BASE ?? `http://${host}:4317`;
  const trackId = encodeURIComponent(encodeId({ kind: "track", videoId }));
  return `${base}/api/stream/youtube-music/${trackId}.m4a`;
}

function detectLanIp(): string | null {
  // Skip Tailscale/VPN CGNAT addresses (100.64.0.0/10) and link-local — the
  // Sonos speaker is on the physical LAN and can't reach those. Prefer a real
  // private-LAN address; fall back to the first usable one otherwise.
  let fallback: string | null = null;
  for (const list of Object.values(networkInterfaces())) {
    if (!list) continue;
    for (const iface of list) {
      if (iface.family !== "IPv4" || iface.internal) continue;
      if (isCgnat(iface.address) || iface.address.startsWith("169.254.")) continue;
      fallback ??= iface.address;
      if (isPrivateLan(iface.address)) return iface.address;
    }
  }
  return fallback;
}

function isCgnat(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

function isPrivateLan(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  if (a === 192 && b === 168) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}
