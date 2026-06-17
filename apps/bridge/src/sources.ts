import type { SourceBrowseItem, SourceBrowseResponse, SourceDescriptor, SourceTrackInfo } from "@misonos/sonos-protocol";

interface SourceConfig {
  id: string;
  baseUrl: string;
}

// Archive.org-backed sources whose own thumbnails are generic — prefer iTunes cover art,
// falling back to the source's native (archive __ia_thumb) image.
// live-music-archive has no real cover art, so substitute iTunes album covers by
// artist/album. grateful-dead-archive is NOT here: it now serves real GDAO show art
// (see grateful-dead-db), which a generic iTunes album cover would wrongly override.
const ITUNES_ART_SOURCES = new Set(["live-music-archive"]);

// Rewrite a browse item's raw art into a bridge `/api/art?…` URL (proxied + cached, lazy).
function bridgeArtUrl(sourceId: string, item: SourceBrowseItem): string | undefined {
  const native = item.albumArtUri;
  if (ITUNES_ART_SOURCES.has(sourceId) && item.artist) {
    const params = new URLSearchParams({ artist: item.artist });
    if (item.album) params.set("album", item.album);
    if (native) params.set("fallback", native);
    return `/api/art?${params.toString()}`;
  }
  if (native && /^https?:\/\//i.test(native)) return `/api/art?u=${encodeURIComponent(native)}`;
  return native;
}

const DEFAULT_SOURCES: SourceConfig[] = [
  { id: "grateful-dead-archive", baseUrl: process.env.MISONOS_GRATEFUL_URL ?? "http://127.0.0.1:4319" },
  { id: "phish-in", baseUrl: process.env.MISONOS_PHISH_URL ?? "http://127.0.0.1:4320" },
  { id: "youtube-music", baseUrl: process.env.MISONOS_YTM_URL ?? "http://127.0.0.1:4321" },
  { id: "live-music-archive", baseUrl: process.env.MISONOS_LMA_URL ?? "http://127.0.0.1:4322" },
  { id: "podcasts", baseUrl: process.env.MISONOS_PODCAST_URL ?? "http://127.0.0.1:4323" },
  { id: "tunein", baseUrl: process.env.MISONOS_TUNEIN_URL ?? "http://127.0.0.1:4324" }
];

const FETCH_TIMEOUT_MS = 8000;
// Browse can fan out into many sequential upstream calls (e.g. YouTube Music's
// Supermix pages a radio across ~9 requests), so give it more headroom.
const BROWSE_TIMEOUT_MS = 30000;
const infoCache = new Map<string, SourceDescriptor>();

export function listSourceConfigs(): SourceConfig[] {
  return [...DEFAULT_SOURCES];
}

export async function listSources(): Promise<SourceDescriptor[]> {
  const results = await Promise.all(
    DEFAULT_SOURCES.map(async (config) => {
      try {
        const info = await fetchInfo(config);
        return info;
      } catch {
        return null;
      }
    })
  );
  return results.filter((value): value is SourceDescriptor => value !== null);
}

export async function browseSource(sourceId: string, id?: string): Promise<SourceBrowseResponse> {
  const config = requireConfig(sourceId);
  const info = await fetchInfo(config);
  const queryId = id ?? info.rootId;
  const target = new URL("/browse", config.baseUrl);
  target.searchParams.set("id", queryId);
  const result = await fetchJson<SourceBrowseResponse>(target, undefined, BROWSE_TIMEOUT_MS);
  return {
    ...result,
    items: result.items.map((item) => ({ ...item, albumArtUri: bridgeArtUrl(sourceId, item) }))
  };
}

export async function fetchTrack(sourceId: string, id: string): Promise<SourceTrackInfo> {
  const config = requireConfig(sourceId);
  const target = new URL("/track", config.baseUrl);
  target.searchParams.set("id", id);
  return fetchJson<SourceTrackInfo>(target);
}

export async function searchSource(sourceId: string, query: string, type?: string): Promise<SourceBrowseResponse> {
  const config = requireConfig(sourceId);
  const target = new URL("/search", config.baseUrl);
  target.searchParams.set("q", query);
  if (type) target.searchParams.set("type", type);
  return fetchJson<SourceBrowseResponse>(target);
}

export async function sourceAuthStatus(sourceId: string): Promise<unknown> {
  const config = requireConfig(sourceId);
  return fetchJson<unknown>(new URL("/auth/status", config.baseUrl));
}

export async function sourceAuthSetCookies(sourceId: string, raw: string): Promise<unknown> {
  const config = requireConfig(sourceId);
  // The source reads the body as a raw cURL/header paste, not JSON.
  return fetchJson<unknown>(new URL("/auth/cookies", config.baseUrl), {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: raw
  });
}

export async function sourceAuthClearCookies(sourceId: string): Promise<unknown> {
  const config = requireConfig(sourceId);
  return fetchJson<unknown>(new URL("/auth/cookies/clear", config.baseUrl), { method: "POST" });
}

export async function sourceSubscriptions(sourceId: string): Promise<unknown> {
  const config = requireConfig(sourceId);
  return fetchJson<unknown>(new URL("/subscriptions", config.baseUrl));
}

export async function sourcePin(sourceId: string, id: string, pinned: boolean): Promise<unknown> {
  const config = requireConfig(sourceId);
  return fetchJson<unknown>(new URL(pinned ? "/pin" : "/unpin", config.baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id })
  });
}

async function fetchInfo(config: SourceConfig): Promise<SourceDescriptor> {
  const cached = infoCache.get(config.id);
  if (cached) return cached;
  const target = new URL("/info", config.baseUrl);
  const info = await fetchJson<SourceDescriptor>(target);
  const merged: SourceDescriptor = { ...info, baseUrl: config.baseUrl };
  infoCache.set(config.id, merged);
  return merged;
}

function requireConfig(sourceId: string): SourceConfig {
  const config = DEFAULT_SOURCES.find((entry) => entry.id === sourceId);
  if (!config) throw new Error(`Unknown source: ${sourceId}`);
  return config;
}

async function fetchJson<T>(target: URL, init?: RequestInit, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(target, { ...init, signal: controller.signal });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Source ${target.host} returned ${response.status}: ${text.slice(0, 200)}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}
