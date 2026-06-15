import type { PodcastConfig } from "./config.js";
import { isConfigured, searchShows, type PodcastShow } from "./podcastIndex.js";
import { searchShowsItunes } from "./itunes.js";

// Prefer Podcast Index when a key is configured; fall back to the key-free Apple
// directory (and use it as a backstop if Podcast Index errors).
export async function searchPodcasts(config: PodcastConfig, query: string): Promise<PodcastShow[]> {
  if (isConfigured(config)) {
    try {
      const results = await searchShows(config, query);
      if (results.length > 0) return results;
    } catch (error) {
      console.warn(`[podcasts] Podcast Index search failed, falling back to iTunes: ${error instanceof Error ? error.message : error}`);
    }
  }
  return searchShowsItunes(query);
}
