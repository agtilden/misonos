// Resolve nicer cover art via the free iTunes Search API (no key). Used as the
// preferred art for archive.org live recordings, whose own thumbnails are generic.

const ITUNES_TIMEOUT_MS = 5000;
const NEGATIVE = Symbol("itunes-miss");
const RESOLVE_TTL_MS = 60 * 60 * 1000;

interface CacheEntry { value: string | typeof NEGATIVE; expires: number }
const cache = new Map<string, CacheEntry>();

/** Best-effort album-art URL for an artist (+ optional album). Never throws; undefined on miss. */
export async function resolveItunesArt(artist: string | undefined, album: string | undefined): Promise<string | undefined> {
  if (!artist) return undefined;
  const key = `${artist}\n${album ?? ""}`.toLowerCase();
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expires > now) return cached.value === NEGATIVE ? undefined : cached.value;

  // Try "artist album" first for a closer match, then "artist" alone for a consistent band cover.
  const terms = album ? [`${artist} ${album}`, artist] : [artist];
  for (const term of terms) {
    const url = await searchOne(term);
    if (url) {
      cache.set(key, { value: url, expires: now + RESOLVE_TTL_MS });
      return url;
    }
  }
  cache.set(key, { value: NEGATIVE, expires: now + RESOLVE_TTL_MS });
  return undefined;
}

async function searchOne(term: string): Promise<string | undefined> {
  const target = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=album&limit=1&media=music`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ITUNES_TIMEOUT_MS);
  try {
    const response = await fetch(target, { headers: { Accept: "application/json" }, signal: controller.signal });
    if (!response.ok) return undefined;
    const data = (await response.json()) as { results?: { artworkUrl100?: string }[] };
    const artwork = data.results?.[0]?.artworkUrl100;
    if (!artwork) return undefined;
    // Upscale the 100x100 thumbnail to a crisper size.
    return artwork.replace(/\/\d+x\d+bb\.(jpg|png)$/i, "/300x300bb.$1");
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
