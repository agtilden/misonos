import { createHash } from "node:crypto";
import type { PodcastConfig } from "./config.js";

export interface PodcastShow {
  feedUrl: string;
  title: string;
  author?: string;
  image?: string;
}

const BASE = "https://api.podcastindex.org/api/1.0";
const USER_AGENT = "MiSonos-Podcasts/0.1";
const TIMEOUT_MS = 8000;

export function isConfigured(config: PodcastConfig): boolean {
  return !!(config.podcastIndexKey && config.podcastIndexSecret);
}

function authHeaders(config: PodcastConfig): Record<string, string> {
  const key = config.podcastIndexKey ?? "";
  const secret = config.podcastIndexSecret ?? "";
  const date = Math.floor(Date.now() / 1000).toString();
  const authorization = createHash("sha1").update(key + secret + date).digest("hex");
  return {
    "User-Agent": USER_AGENT,
    "X-Auth-Key": key,
    "X-Auth-Date": date,
    Authorization: authorization
  };
}

async function get(config: PodcastConfig, path: string): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE}${path}`, { headers: authHeaders(config), signal: controller.signal });
    if (!response.ok) throw new Error(`Podcast Index ${response.status}`);
    return await response.json() as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

export async function searchShows(config: PodcastConfig, query: string, max = 40): Promise<PodcastShow[]> {
  const data = await get(config, `/search/byterm?q=${encodeURIComponent(query)}&max=${max}`);
  const feeds = (data.feeds as Record<string, unknown>[] | undefined) ?? [];
  return feeds.map(toShow).filter((show): show is PodcastShow => show !== null);
}

function toShow(feed: Record<string, unknown>): PodcastShow | null {
  const feedUrl = typeof feed.url === "string" ? feed.url : undefined;
  const title = typeof feed.title === "string" ? feed.title : undefined;
  if (!feedUrl || !title) return null;
  return {
    feedUrl,
    title,
    author: typeof feed.author === "string" ? feed.author : undefined,
    image: typeof feed.artwork === "string" ? feed.artwork : typeof feed.image === "string" ? feed.image : undefined
  };
}
