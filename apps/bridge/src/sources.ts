import type { SourceBrowseResponse, SourceDescriptor, SourceTrackInfo } from "@misonos/sonos-protocol";

interface SourceConfig {
  id: string;
  baseUrl: string;
}

const DEFAULT_SOURCES: SourceConfig[] = [
  { id: "grateful-dead-archive", baseUrl: process.env.MISONOS_GRATEFUL_URL ?? "http://127.0.0.1:4319" },
  { id: "phish-in", baseUrl: process.env.MISONOS_PHISH_URL ?? "http://127.0.0.1:4320" },
  { id: "youtube-music", baseUrl: process.env.MISONOS_YTM_URL ?? "http://127.0.0.1:4321" },
  { id: "live-music-archive", baseUrl: process.env.MISONOS_LMA_URL ?? "http://127.0.0.1:4322" }
];

const FETCH_TIMEOUT_MS = 8000;
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
  return fetchJson<SourceBrowseResponse>(target);
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

export async function sourceAuthStart(sourceId: string): Promise<unknown> {
  const config = requireConfig(sourceId);
  // Cold-start can take 10-30s while youtubei.js downloads the player JS, so
  // give this call a longer timeout than ordinary browse calls.
  return fetchJson<unknown>(new URL("/auth/start", config.baseUrl), { method: "POST" }, 45000);
}

export async function sourceAuthSignOut(sourceId: string): Promise<unknown> {
  const config = requireConfig(sourceId);
  return fetchJson<unknown>(new URL("/auth/signout", config.baseUrl), { method: "POST" });
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
