import type { SourceBrowseItem } from "@misonos/sonos-protocol";
import type { PodcastConfig } from "./config.js";
import { encodeId } from "./ids.js";
import { getFeed, type PodcastEpisode, type PodcastFeed } from "./feed.js";
import { searchPodcasts } from "./search.js";
import type { PodcastShow } from "./podcastIndex.js";
import type { SubscriptionStore } from "./store.js";

const NEW_EPISODES_LIMIT = 60;
const SHOW_EPISODES_LIMIT = 300;

export function browseRoot(store: SubscriptionStore): SourceBrowseItem[] {
  const items: SourceBrowseItem[] = [
    { id: encodeId({ kind: "new-episodes" }), title: "New Episodes", kind: "container", subtitle: "Latest from your podcasts" }
  ];
  for (const sub of store.list()) items.push(showItem(sub));
  return items;
}

export async function browseShow(feedUrl: string): Promise<SourceBrowseItem[]> {
  const feed = await getFeed(feedUrl);
  return feed.episodes.slice(0, SHOW_EPISODES_LIMIT).map((episode) => episodeItem(feed, episode));
}

// Merge the most recent episodes across every pinned show, newest first.
export async function browseNewEpisodes(store: SubscriptionStore): Promise<SourceBrowseItem[]> {
  const subs = store.list();
  const feeds = await Promise.all(subs.map(async (sub) => {
    try {
      return await getFeed(sub.feedUrl);
    } catch (error) {
      console.warn(`[podcasts] new-episodes: feed failed ${sub.feedUrl}: ${error instanceof Error ? error.message : error}`);
      return null;
    }
  }));
  const rows: { feed: PodcastFeed; episode: PodcastEpisode }[] = [];
  for (const feed of feeds) {
    if (!feed) continue;
    for (const episode of feed.episodes.slice(0, 15)) rows.push({ feed, episode });
  }
  rows.sort((a, b) => (b.episode.pubDateMs ?? 0) - (a.episode.pubDateMs ?? 0));
  return rows.slice(0, NEW_EPISODES_LIMIT).map(({ feed, episode }) => episodeItem(feed, episode, true));
}

export async function searchResults(config: PodcastConfig, query: string): Promise<SourceBrowseItem[]> {
  const shows = await searchPodcasts(config, query);
  return shows.map(showItem);
}

function showItem(show: PodcastShow): SourceBrowseItem {
  return {
    id: encodeId({ kind: "show", feedUrl: show.feedUrl }),
    title: show.title,
    kind: "container",
    subtitle: show.author,
    albumArtUri: show.image
  };
}

function episodeItem(feed: PodcastFeed, episode: PodcastEpisode, showShowName = false): SourceBrowseItem {
  const date = episode.pubDateMs ? new Date(episode.pubDateMs).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : undefined;
  const subtitle = showShowName ? [feed.title, date].filter(Boolean).join(" · ") : date;
  return {
    id: encodeId({ kind: "episode", feedUrl: feed.feedUrl, guid: episode.guid }),
    title: episode.title,
    kind: "playable",
    subtitle,
    artist: feed.title,
    album: feed.title,
    durationSeconds: episode.durationSeconds,
    albumArtUri: episode.image ?? feed.image
  };
}
