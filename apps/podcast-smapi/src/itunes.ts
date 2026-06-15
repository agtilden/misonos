import type { PodcastShow } from "./podcastIndex.js";

const TIMEOUT_MS = 8000;

// Zero-key fallback: Apple Podcasts directory search. Returns the show's feed URL
// and artwork; episodes always come from the feed itself.
export async function searchShowsItunes(query: string, limit = 40): Promise<PodcastShow[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url = `https://itunes.apple.com/search?media=podcast&limit=${limit}&term=${encodeURIComponent(query)}`;
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`iTunes ${response.status}`);
    const data = await response.json() as { results?: Record<string, unknown>[] };
    return (data.results ?? []).map(toShow).filter((show): show is PodcastShow => show !== null);
  } finally {
    clearTimeout(timer);
  }
}

function toShow(result: Record<string, unknown>): PodcastShow | null {
  const feedUrl = typeof result.feedUrl === "string" ? result.feedUrl : undefined;
  const title = typeof result.collectionName === "string" ? result.collectionName : undefined;
  if (!feedUrl || !title) return null;
  const art = result.artworkUrl600 ?? result.artworkUrl100 ?? result.artworkUrl60;
  return {
    feedUrl,
    title,
    author: typeof result.artistName === "string" ? result.artistName : undefined,
    image: typeof art === "string" ? art : undefined
  };
}
