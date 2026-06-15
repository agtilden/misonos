import type { SourceBrowseItem, SourceBrowseResponse } from "@misonos/sonos-protocol";
import { encodeId, decodeId, type YtmId } from "./ids.js";
import { browseMusic, nextPlaylist, panelTracks, parseShelves, parseShelfItem, searchMusic, type ParsedItem, type ParsedShelf } from "./ytmApi.js";
import { hasCookieAuth } from "./cookieAuth.js";

export async function browse(rawId: string): Promise<SourceBrowseResponse> {
  const id = decodeId(rawId);
  const items = await browseId(id);
  return { id: rawId, title: titleFor(id), total: items.length, items };
}

async function browseId(id: YtmId): Promise<SourceBrowseItem[]> {
  switch (id.kind) {
    case "root": {
      const roots = [
        container(encodeId({ kind: "home" }), "Home"),
        container(encodeId({ kind: "new-releases" }), "New Releases"),
        container(encodeId({ kind: "charts" }), "Charts")
      ];
      // Personalized surfaces only resolve with pasted cookie auth.
      if (hasCookieAuth()) {
        roots.push(
          container(encodeId({ kind: "library" }), "Your Library"),
          container(encodeId({ kind: "supermix" }), "My Supermix")
        );
      }
      return roots;
    }
    case "search-songs":
    case "search-artists":
    case "search-albums":
      return [];
    case "search":
      return runSearch(id.query, "song");
    case "home":
      // Authenticated home is personalized (and surfaces Supermix shelves).
      return shelvesAsItems(await safeShelves("FEmusic_home", "home", hasCookieAuth()));
    case "new-releases":
      return shelvesAsItems(await safeShelves("FEmusic_explore", "new-releases"));
    case "charts":
      return shelvesAsItems(await safeShelves("FEmusic_charts", "charts"));
    case "library":
      return shelvesAsItems(await safeShelves("FEmusic_library_landing", "library", true));
    case "library-playlists":
      return shelvesAsItems(await safeShelves("FEmusic_liked_playlists", "library-playlists", true));
    case "library-liked":
      return playlistTracks("LM", true);
    case "library-songs":
      return shelvesAsItems(await safeShelves("FEmusic_library_privately_owned_tracks", "library-songs", true));
    case "library-albums":
      return shelvesAsItems(await safeShelves("FEmusic_liked_albums", "library-albums", true));
    case "library-artists":
      return shelvesAsItems(await safeShelves("FEmusic_corpus_artists", "library-artists", true));
    case "library-subscriptions":
      return shelvesAsItems(await safeShelves("FEmusic_library_corpus_artists", "library-subscriptions", true));
    case "library-history":
      return shelvesAsItems(await safeShelves("FEmusic_history", "library-history", true));
    case "supermix":
      return supermixTracks();
    case "artist":
      return shelvesAsItems(await safeShelves(id.channelId, `artist:${id.channelId}`));
    case "album":
      return albumTracks(id.browseId);
    case "playlist":
      return playlistTracks(id.playlistId, hasCookieAuth());
    case "track":
      throw new Error("Tracks are leaves");
  }
}

async function safeShelves(browseId: string, label: string, authed = false): Promise<ParsedShelf[]> {
  try {
    const response = await browseMusic(browseId, undefined, { authed });
    const sections = sectionList(response);
    console.log(`[ytmusic] browse [${label}] sections:`, sections.map((s) => (s && typeof s === "object") ? Object.keys(s as Record<string, unknown>)[0] : "?"));
    return parseShelves(sections);
  } catch (error) {
    console.warn(`[ytmusic] browse fetch failed [${label}]:`, error instanceof Error ? error.message : error);
    // Stale/expired cookies shouldn't break public feeds (e.g. Home) — retry anonymously.
    if (authed) {
      try {
        return parseShelves(sectionList(await browseMusic(browseId, undefined, { authed: false })));
      } catch {
        return [];
      }
    }
    return [];
  }
}

function shelvesAsItems(shelves: ParsedShelf[]): SourceBrowseItem[] {
  const out: SourceBrowseItem[] = [];
  const multi = shelves.length > 1;
  for (const shelf of shelves) {
    const shelfItems: SourceBrowseItem[] = [];
    for (const item of shelf.items) {
      const converted = toSourceItem(item, multi ? undefined : shelf.title);
      if (converted) shelfItems.push(converted);
    }
    if (shelfItems.length === 0) continue;
    if (multi && shelf.title) {
      out.push({ id: `section:${shelf.title}:${out.length}`, title: shelf.title, kind: "section" });
    }
    out.push(...shelfItems);
  }
  return out;
}

function toSourceItem(item: ParsedItem, shelfTitle: string | undefined): SourceBrowseItem | null {
  const subtitle = item.subtitle ?? shelfTitle;
  if (item.kind === "artist" && item.browseId) {
    return container(encodeId({ kind: "artist", channelId: item.browseId }), item.title, subtitle, item.thumbnailUrl);
  }
  if (item.kind === "album" && item.browseId) {
    return container(encodeId({ kind: "album", browseId: item.browseId }), item.title, subtitle, item.thumbnailUrl);
  }
  const playlistId = playlistIdOf(item);
  if (item.kind === "playlist" && playlistId) {
    return container(encodeId({ kind: "playlist", playlistId }), item.title, subtitle, item.thumbnailUrl);
  }
  if (item.kind === "song" && item.videoId) {
    return {
      id: encodeId({ kind: "track", videoId: item.videoId }),
      title: item.title,
      kind: "playable",
      subtitle,
      artist: item.artist,
      album: item.album,
      durationSeconds: item.durationSeconds,
      albumArtUri: item.thumbnailUrl
    };
  }
  return null;
}

export async function runSearch(query: string, type: "song" | "artist" | "album"): Promise<SourceBrowseItem[]> {
  if (!query.trim()) return [];
  // YT Music search "params" values (well-known filter tokens)
  const params = type === "song"
    ? "EgWKAQIIAWoMEA4QChADEAQQCRAF"
    : type === "artist"
      ? "EgWKAQIgAWoMEA4QChADEAQQCRAF"
      : "EgWKAQIYAWoMEA4QChADEAQQCRAF";
  let response;
  try {
    response = await searchMusic(query, params);
  } catch (error) {
    console.warn("[ytmusic] search failed:", error instanceof Error ? error.message : error);
    return [];
  }
  const sections = sectionList(response);
  const sectionKinds = sections.map((s) => {
    if (!s || typeof s !== "object") return "?";
    const keys = Object.keys(s as Record<string, unknown>);
    return keys.length ? keys[0] : "?";
  });
  console.log(`[ytmusic] search "${query}" type=${type} sections:`, sectionKinds);
  const out: SourceBrowseItem[] = [];
  for (const section of sections) {
    const shelf = nav(section, ["musicShelfRenderer"]);
    if (shelf) {
      const contents = nav(shelf, ["contents"]) as unknown[] | undefined;
      if (Array.isArray(contents)) {
        for (const raw of contents) {
          const parsed = parseShelfItem(raw);
          if (!parsed) continue;
          const item = toSourceItem(parsed, undefined);
          if (item) out.push(item);
        }
      }
      continue;
    }
    const cardShelf = nav(section, ["musicCardShelfRenderer"]);
    if (cardShelf) {
      const contents = nav(cardShelf, ["contents"]) as unknown[] | undefined;
      if (Array.isArray(contents)) {
        for (const raw of contents) {
          const parsed = parseShelfItem(raw);
          if (!parsed) continue;
          const item = toSourceItem(parsed, undefined);
          if (item) out.push(item);
        }
      }
      continue;
    }
  }
  console.log(`[ytmusic] search "${query}" returning ${out.length} items`);
  return out;
}

async function albumTracks(browseId: string): Promise<SourceBrowseItem[]> {
  try {
    const response = await browseMusic(browseId);
    // Album page has tracks inside musicShelfRenderer (sometimes under twoColumnBrowseResultsRenderer)
    const sections = sectionList(response);
    const out: SourceBrowseItem[] = [];
    for (const section of sections) {
      const shelf = nav(section, ["musicShelfRenderer"]);
      if (!shelf) continue;
      const contents = nav(shelf, ["contents"]) as unknown[] | undefined;
      if (!Array.isArray(contents)) continue;
      for (const raw of contents) {
        const parsed = parseShelfItem(raw);
        if (!parsed) continue;
        const item = toSourceItem(parsed, undefined);
        if (item) out.push(item);
      }
    }
    return out;
  } catch (error) {
    console.warn(`[ytmusic] album fetch failed [${browseId}]:`, error instanceof Error ? error.message : error);
    return [];
  }
}

async function playlistTracks(playlistId: string, authed = false): Promise<SourceBrowseItem[]> {
  // Radio / auto playlists (Supermix etc.) don't resolve via VL browse.
  if (playlistId.startsWith("RD")) return radioTracks(playlistId);
  try {
    const response = await browseMusic(`VL${playlistId}`, undefined, { authed });
    const sections = sectionList(response);
    const out: SourceBrowseItem[] = [];
    for (const section of sections) {
      const shelf = nav(section, ["musicPlaylistShelfRenderer"]) ?? nav(section, ["musicShelfRenderer"]);
      if (!shelf) continue;
      const contents = nav(shelf, ["contents"]) as unknown[] | undefined;
      if (!Array.isArray(contents)) continue;
      for (const raw of contents) {
        const parsed = parseShelfItem(raw);
        if (!parsed) continue;
        const item = toSourceItem(parsed, undefined);
        if (item) out.push(item);
      }
    }
    return out;
  } catch (error) {
    console.warn(`[ytmusic] playlist fetch failed [${playlistId}]:`, error instanceof Error ? error.message : error);
    return [];
  }
}

async function radioTracks(playlistId: string): Promise<SourceBrowseItem[]> {
  try {
    const response = await nextPlaylist(playlistId);
    const out: SourceBrowseItem[] = [];
    for (const item of panelTracks(response)) {
      const converted = toSourceItem(item, undefined);
      if (converted) out.push(converted);
    }
    return out;
  } catch (error) {
    console.warn(`[ytmusic] radio fetch failed [${playlistId}]:`, error instanceof Error ? error.message : error);
    return [];
  }
}

// "My Supermix" isn't a fixed id — find it in the authenticated home feed (a radio
// playlist whose title says Supermix, or the personalized RDTMAK mix) and enumerate it.
async function supermixTracks(): Promise<SourceBrowseItem[]> {
  const shelves = await safeShelves("FEmusic_home", "supermix", true);
  let fallback: string | undefined;
  for (const shelf of shelves) {
    for (const item of shelf.items) {
      const playlistId = playlistIdOf(item);
      if (!playlistId) continue;
      if (/supermix/i.test(item.title)) return radioTracks(playlistId);
      if (!fallback && playlistId.startsWith("RDTMAK")) fallback = playlistId;
    }
  }
  return fallback ? radioTracks(fallback) : [];
}

function playlistIdOf(item: ParsedItem): string | undefined {
  if (item.kind !== "playlist") return undefined;
  if (item.playlistId) return item.playlistId;
  if (item.browseId) return item.browseId.startsWith("VL") ? item.browseId.slice(2) : item.browseId;
  return undefined;
}

function container(id: string, title: string, subtitle?: string, albumArtUri?: string): SourceBrowseItem {
  return { id, title, kind: "container", subtitle, albumArtUri };
}

// Re-imported helpers because TS otherwise treats them as unused in this module.
function sectionList(response: unknown): unknown[] {
  const single = nav(response, ["contents", "singleColumnBrowseResultsRenderer", "tabs", 0, "tabRenderer", "content", "sectionListRenderer", "contents"]);
  if (Array.isArray(single)) return single as unknown[];
  const tabbed = nav(response, ["contents", "tabbedSearchResultsRenderer", "tabs", 0, "tabRenderer", "content", "sectionListRenderer", "contents"]);
  if (Array.isArray(tabbed)) return tabbed as unknown[];
  const twoColumn = nav(response, ["contents", "twoColumnBrowseResultsRenderer", "secondaryContents", "sectionListRenderer", "contents"]);
  if (Array.isArray(twoColumn)) return twoColumn as unknown[];
  return [];
}

function nav(root: unknown, path: (string | number)[]): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof key === "number") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[key];
    } else {
      if (typeof cur !== "object") return undefined;
      cur = (cur as Record<string, unknown>)[key];
    }
  }
  return cur;
}

function titleFor(id: YtmId): string {
  switch (id.kind) {
    case "root": return "YouTube Music";
    case "search-songs": return "Songs";
    case "search-artists": return "Artists";
    case "search-albums": return "Albums";
    case "search": return `Search: ${id.query}`;
    case "home": return "Home";
    case "new-releases": return "New Releases";
    case "charts": return "Charts";
    case "library": return "Your Library";
    case "library-playlists": return "Playlists";
    case "library-liked": return "Liked Songs";
    case "library-songs": return "Songs";
    case "library-albums": return "Albums";
    case "library-artists": return "Artists";
    case "library-subscriptions": return "Subscriptions";
    case "library-history": return "History";
    case "supermix": return "My Supermix";
    case "artist": return "Artist";
    case "album": return "Album";
    case "playlist": return "Playlist";
    case "track": return "Track";
  }
}
