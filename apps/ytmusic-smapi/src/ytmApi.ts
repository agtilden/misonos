import { cookieAuthHeaders, invalidateCookieAuth } from "./cookieAuth.js";

const YTM_DOMAIN = "https://music.youtube.com";
const YTM_API_BASE = `${YTM_DOMAIN}/youtubei/v1/`;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:88.0) Gecko/20100101 Firefox/88.0";

let visitorIdPromise: Promise<string> | null = null;

type AnyRec = Record<string, unknown>;

function todayClientVersion(): string {
  const d = new Date();
  const yyyymmdd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  return `1.${yyyymmdd}.01.00`;
}

async function getVisitorId(): Promise<string> {
  if (visitorIdPromise) return visitorIdPromise;
  visitorIdPromise = (async () => {
    const response = await fetch(YTM_DOMAIN, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.5"
      }
    });
    const text = await response.text();
    const match = text.match(/ytcfg\.set\s*\(\s*(\{.+?\})\s*\)\s*;/);
    if (!match) throw new Error("Could not extract VISITOR_DATA from music.youtube.com");
    try {
      const cfg = JSON.parse(match[1]) as { VISITOR_DATA?: string };
      const visitor = cfg.VISITOR_DATA;
      if (!visitor) throw new Error("ytcfg has no VISITOR_DATA");
      return visitor;
    } catch (error) {
      visitorIdPromise = null;
      throw error;
    }
  })();
  return visitorIdPromise;
}

export async function ytmPost(endpoint: string, body: AnyRec, opts?: { authed?: boolean }): Promise<AnyRec> {
  const visitor = await getVisitorId();
  const payload = {
    ...body,
    context: {
      client: {
        clientName: "WEB_REMIX",
        clientVersion: todayClientVersion(),
        hl: "en",
        gl: "US"
      },
      user: { lockedSafetyMode: false }
    }
  };
  // Attach the user's pasted cookies + SAPISIDHASH only for personalized calls
  // (library, home, radios); public browse/search stays anonymous.
  const authHeaders = opts?.authed ? cookieAuthHeaders() : {};
  const sentAuth = Object.keys(authHeaders).length > 0;
  const response = await fetch(`${YTM_API_BASE}${endpoint}?alt=json`, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.5",
      "Content-Type": "application/json",
      "Origin": YTM_DOMAIN,
      "Referer": `${YTM_DOMAIN}/`,
      "X-Goog-Visitor-Id": visitor,
      "X-YouTube-Client-Name": "67",
      "X-YouTube-Client-Version": todayClientVersion(),
      ...authHeaders
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    // Cookies were rejected — drop them so we stop reporting "connected" and stop
    // sending dead credentials; the caller falls back to anonymous.
    if (sentAuth && (response.status === 401 || response.status === 403)) invalidateCookieAuth();
    const text = await response.text();
    throw new Error(`YT Music ${response.status} on ${endpoint}: ${text.slice(0, 300)}`);
  }
  return response.json() as Promise<AnyRec>;
}

export async function browseMusic(browseId: string, params?: string, opts?: { authed?: boolean }): Promise<AnyRec> {
  const body: AnyRec = { browseId };
  if (params) body.params = params;
  return ytmPost("browse", body, opts);
}

export async function searchMusic(query: string, params?: string): Promise<AnyRec> {
  const body: AnyRec = { query };
  if (params) body.params = params;
  return ytmPost("search", body);
}

// Enumerate a radio/auto playlist (e.g. a Supermix, id starts with "RD") via the
// watch-next endpoint — these don't resolve through the regular VL browse path.
export async function nextPlaylist(playlistId: string, videoId?: string): Promise<AnyRec> {
  const body: AnyRec = { playlistId, isAudioOnly: true };
  if (videoId) body.videoId = videoId;
  return ytmPost("next", body, { authed: true });
}

// Fetch a further page of a radio panel using a continuation token.
export async function nextContinuation(continuation: string): Promise<AnyRec> {
  return ytmPost("next", { continuation, isAudioOnly: true }, { authed: true });
}

function playlistPanel(response: unknown): unknown {
  return nav(response, [
    "contents", "singleColumnMusicWatchNextResultsRenderer", "tabbedRenderer",
    "watchNextTabbedResultsRenderer", "tabs", 0, "tabRenderer", "content",
    "musicQueueRenderer", "content", "playlistPanelRenderer"
  ]) ?? nav(response, ["continuationContents", "playlistPanelContinuation"]);
}

export function panelTracks(response: unknown): ParsedItem[] {
  const panel = playlistPanel(response);
  const contents = nav(panel, ["contents"]) as unknown[] | undefined;
  if (!Array.isArray(contents)) return [];
  const out: ParsedItem[] = [];
  for (const raw of contents) {
    const r = nav(raw, ["playlistPanelVideoRenderer"]);
    if (!r) continue;
    const title = textRun(nav(r, ["title"]));
    const videoId = nav(r, ["videoId"]) as string | undefined;
    if (!title || !videoId) continue;
    const bylineRuns = nav(r, ["shortBylineText", "runs"]) ?? nav(r, ["longBylineText", "runs"]);
    const artist = Array.isArray(bylineRuns) && bylineRuns.length > 0 ? (bylineRuns[0] as AnyRec).text as string | undefined : undefined;
    const durText = textRun(nav(r, ["lengthText"]));
    out.push({
      kind: "song",
      title,
      videoId,
      artist,
      durationSeconds: durText ? parseDuration(durText) : undefined,
      thumbnailUrl: thumbnailFrom(r)
    });
  }
  return out;
}

// The token to fetch the next page of a radio panel, if any.
export function panelContinuation(response: unknown): string | undefined {
  const panel = playlistPanel(response);
  const token = nav(panel, ["continuations", 0, "nextRadioContinuationData", "continuation"])
    ?? nav(panel, ["continuations", 0, "nextContinuationData", "continuation"]);
  return typeof token === "string" ? token : undefined;
}

export interface TrackInfo {
  title: string;
  artist?: string;
  album?: string;
  durationSeconds?: number;
  thumbnailUrl?: string;
}

export async function getTrackInfo(videoId: string): Promise<TrackInfo | null> {
  try {
    const response = await ytmPost("player", { videoId });
    const details = response.videoDetails as AnyRec | undefined;
    if (!details) {
      console.warn(`[ytmusic] player response missing videoDetails (keys=${Object.keys(response).join(",")})`);
      return null;
    }
    const title = typeof details.title === "string" ? details.title : videoId;
    const artist = typeof details.author === "string" ? details.author : undefined;
    const lengthRaw = details.lengthSeconds;
    const durationSeconds = typeof lengthRaw === "string" ? Number.parseInt(lengthRaw, 10) : typeof lengthRaw === "number" ? lengthRaw : undefined;
    const thumbnails = nav(details, ["thumbnail", "thumbnails"]) as AnyRec[] | undefined;
    let thumbnailUrl: string | undefined;
    if (Array.isArray(thumbnails) && thumbnails.length > 0) {
      const last = thumbnails[thumbnails.length - 1];
      if (typeof last.url === "string") thumbnailUrl = last.url;
    }
    // Try to read album from microformat/playerMicroformatRenderer if present
    const album = nav(response, ["microformat", "playerMicroformatRenderer", "album"]) as string | undefined;
    return { title, artist, album: typeof album === "string" ? album : undefined, durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : undefined, thumbnailUrl };
  } catch (error) {
    console.warn("[ytmusic] track info fetch failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

// ---------- Response navigation ----------

export function nav(root: unknown, path: (string | number)[]): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof key === "number") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[key];
    } else {
      if (typeof cur !== "object") return undefined;
      cur = (cur as AnyRec)[key];
    }
  }
  return cur;
}

export function sectionList(response: unknown): unknown[] {
  // Try modern singleColumn layout first
  const single = nav(response, ["contents", "singleColumnBrowseResultsRenderer", "tabs", 0, "tabRenderer", "content", "sectionListRenderer", "contents"]);
  if (Array.isArray(single)) return single as unknown[];
  // Two-column album/playlist layouts
  const twoColumn = nav(response, ["contents", "twoColumnBrowseResultsRenderer", "secondaryContents", "sectionListRenderer", "contents"]);
  if (Array.isArray(twoColumn)) return twoColumn as unknown[];
  return [];
}

export function textRun(node: unknown): string | undefined {
  const text = nav(node, ["runs", 0, "text"]);
  if (typeof text === "string") return text;
  const flat = nav(node, ["simpleText"]);
  if (typeof flat === "string") return flat;
  return undefined;
}

export interface ParsedItem {
  kind: "song" | "video" | "album" | "playlist" | "artist";
  title: string;
  subtitle?: string;
  videoId?: string;
  browseId?: string;
  playlistId?: string;
  durationSeconds?: number;
  artist?: string;
  album?: string;
  thumbnailUrl?: string;
}

export function parseShelfItem(item: unknown): ParsedItem | null {
  const twoRow = nav(item, ["musicTwoRowItemRenderer"]);
  if (twoRow) {
    const parsed = parseTwoRow(twoRow);
    return parsed ? { ...parsed, thumbnailUrl: thumbnailFrom(twoRow) } : null;
  }
  const listItem = nav(item, ["musicResponsiveListItemRenderer"]);
  if (listItem) {
    const parsed = parseResponsiveListItem(listItem);
    return parsed ? { ...parsed, thumbnailUrl: thumbnailFrom(listItem) } : null;
  }
  return null;
}

// Pick the largest thumbnail from a YTM renderer node and bump its requested size.
function thumbnailFrom(node: unknown): string | undefined {
  const thumbs = (nav(node, ["thumbnailRenderer", "musicThumbnailRenderer", "thumbnail", "thumbnails"])
    ?? nav(node, ["thumbnail", "musicThumbnailRenderer", "thumbnail", "thumbnails"])
    ?? nav(node, ["thumbnail", "croppedSquareThumbnailRenderer", "thumbnail", "thumbnails"])
    ?? nav(node, ["thumbnail", "thumbnails"])) as AnyRec[] | undefined;
  if (!Array.isArray(thumbs) || thumbs.length === 0) return undefined;
  const best = thumbs[thumbs.length - 1];
  const url = typeof best.url === "string" ? best.url : undefined;
  if (!url) return undefined;
  // Google art URLs encode a crop like "=w60-h60" or "...-w60-h60-..."; request larger.
  return url.replace(/=w\d+-h\d+/, "=w240-h240").replace(/-w\d+-h\d+(-[a-z])/i, "-w240-h240$1");
}

// The cover shown atop an album/playlist page, so its tracks can inherit it.
export function headerThumbnail(response: unknown): string | undefined {
  const headers = [
    nav(response, ["header", "musicDetailHeaderRenderer"]),
    nav(response, ["header", "musicResponsiveHeaderRenderer"]),
    nav(response, ["contents", "twoColumnBrowseResultsRenderer", "tabs", 0, "tabRenderer", "content", "sectionListRenderer", "contents", 0, "musicResponsiveHeaderRenderer"])
  ];
  for (const header of headers) {
    if (!header) continue;
    const thumb = thumbnailFrom(header);
    if (thumb) return thumb;
  }
  return undefined;
}

// Classify a browse target. Library artists use a LIBRARY_ARTIST page type and an
// MPLA… id that the explicit checks miss, so fall back to id-prefix heuristics.
function pageKind(pageType: string | undefined, browseId: string): ParsedItem["kind"] {
  if (pageType === "MUSIC_PAGE_TYPE_ALBUM") return "album";
  if (pageType === "MUSIC_PAGE_TYPE_ARTIST" || pageType === "MUSIC_PAGE_TYPE_USER_CHANNEL"
    || pageType?.includes("ARTIST") || browseId.startsWith("UC") || browseId.startsWith("MPLA")) {
    return "artist";
  }
  return "playlist";
}

function parseTwoRow(node: unknown): ParsedItem | null {
  const title = textRun(nav(node, ["title"]));
  if (!title) return null;
  const subtitleParts: string[] = [];
  const subRuns = nav(node, ["subtitle", "runs"]);
  if (Array.isArray(subRuns)) {
    for (const run of subRuns) {
      const t = (run as AnyRec).text;
      if (typeof t === "string" && t.trim() && t !== " • ") subtitleParts.push(t);
    }
  }
  const browseEndpoint = nav(node, ["navigationEndpoint", "browseEndpoint"]);
  const watchEndpoint = nav(node, ["navigationEndpoint", "watchEndpoint"]);
  if (browseEndpoint) {
    const browseId = (browseEndpoint as AnyRec).browseId as string | undefined;
    const pageType = nav(browseEndpoint, ["browseEndpointContextSupportedConfigs", "browseEndpointContextMusicConfig", "pageType"]) as string | undefined;
    if (!browseId) return null;
    return { kind: pageKind(pageType, browseId), title, subtitle: subtitleParts.join(" · ") || undefined, browseId };
  }
  if (watchEndpoint) {
    const videoId = (watchEndpoint as AnyRec).videoId as string | undefined;
    const playlistId = (watchEndpoint as AnyRec).playlistId as string | undefined;
    if (videoId) return { kind: "song", title, subtitle: subtitleParts.join(" · ") || undefined, videoId, playlistId };
    // A tile that points at a playlist/radio with no track (e.g. a Supermix).
    if (playlistId) return { kind: "playlist", title, subtitle: subtitleParts.join(" · ") || undefined, playlistId };
    return null;
  }
  // Supermix / radio tiles navigate via a watchPlaylistEndpoint, sometimes only on
  // the play-button overlay rather than the tile's own navigationEndpoint.
  const playEndpoint = nav(node, ["navigationEndpoint", "watchPlaylistEndpoint"])
    ?? nav(node, ["thumbnailOverlay", "musicItemThumbnailOverlayRenderer", "content", "musicPlayButtonRenderer", "playNavigationEndpoint", "watchPlaylistEndpoint"])
    ?? nav(node, ["thumbnailOverlay", "musicItemThumbnailOverlayRenderer", "content", "musicPlayButtonRenderer", "playNavigationEndpoint", "watchEndpoint"]);
  if (playEndpoint) {
    const playlistId = (playEndpoint as AnyRec).playlistId as string | undefined;
    if (playlistId) return { kind: "playlist", title, subtitle: subtitleParts.join(" · ") || undefined, playlistId };
  }
  return null;
}

function parseResponsiveListItem(node: unknown): ParsedItem | null {
  const flexColumns = nav(node, ["flexColumns"]) as unknown[] | undefined;
  if (!Array.isArray(flexColumns) || flexColumns.length === 0) return null;
  const title = textRun(nav(flexColumns[0], ["musicResponsiveListItemFlexColumnRenderer", "text"]));
  if (!title) return null;
  // Subtitle from second column
  let subtitle: string | undefined;
  let artist: string | undefined;
  let album: string | undefined;
  if (flexColumns[1]) {
    const subRuns = nav(flexColumns[1], ["musicResponsiveListItemFlexColumnRenderer", "text", "runs"]) as unknown[] | undefined;
    if (Array.isArray(subRuns)) {
      const subParts: string[] = [];
      for (const run of subRuns) {
        const t = (run as AnyRec).text;
        if (typeof t === "string" && t.trim() && t !== " • ") subParts.push(t);
      }
      subtitle = subParts.join(" · ") || undefined;
      // First run is usually the artist
      const firstArtist = (subRuns[0] as AnyRec | undefined)?.text;
      if (typeof firstArtist === "string") artist = firstArtist;
    }
  }
  if (flexColumns[2]) {
    const albumText = textRun(nav(flexColumns[2], ["musicResponsiveListItemFlexColumnRenderer", "text"]));
    if (albumText) album = albumText;
  }
  // Duration from fixedColumns
  const fixedColumns = nav(node, ["fixedColumns"]) as unknown[] | undefined;
  let durationSeconds: number | undefined;
  if (Array.isArray(fixedColumns) && fixedColumns[0]) {
    const durText = textRun(nav(fixedColumns[0], ["musicResponsiveListItemFixedColumnRenderer", "text"]));
    if (durText) durationSeconds = parseDuration(durText);
  }
  const browseEndpoint = nav(node, ["navigationEndpoint", "browseEndpoint"]);
  const watchEndpoint = nav(node, ["navigationEndpoint", "watchEndpoint"]) ??
    nav(node, ["overlay", "musicItemThumbnailOverlayRenderer", "content", "musicPlayButtonRenderer", "playNavigationEndpoint", "watchEndpoint"]) ??
    nav(node, ["playlistItemData", "videoId"]);
  if (browseEndpoint) {
    const browseId = (browseEndpoint as AnyRec).browseId as string | undefined;
    const pageType = nav(browseEndpoint, ["browseEndpointContextSupportedConfigs", "browseEndpointContextMusicConfig", "pageType"]) as string | undefined;
    if (!browseId) return null;
    return { kind: pageKind(pageType, browseId), title, subtitle, browseId };
  }
  if (typeof watchEndpoint === "string") {
    return { kind: "song", title, subtitle, videoId: watchEndpoint, artist, album, durationSeconds };
  }
  if (watchEndpoint) {
    const videoId = (watchEndpoint as AnyRec).videoId as string | undefined;
    const playlistId = (watchEndpoint as AnyRec).playlistId as string | undefined;
    if (!videoId) return null;
    return { kind: "song", title, subtitle, videoId, playlistId, artist, album, durationSeconds };
  }
  return null;
}

function parseDuration(text: string): number | undefined {
  const parts = text.split(":").map((p) => Number.parseInt(p, 10));
  if (parts.some((p) => Number.isNaN(p))) return undefined;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

export interface ParsedShelf {
  title?: string;
  items: ParsedItem[];
}

export function parseShelves(sections: unknown[]): ParsedShelf[] {
  const out: ParsedShelf[] = [];
  for (const section of sections) {
    const carousel = nav(section, ["musicCarouselShelfRenderer"]);
    if (carousel) {
      const title = textRun(nav(carousel, ["header", "musicCarouselShelfBasicHeaderRenderer", "title"]));
      const contents = nav(carousel, ["contents"]) as unknown[] | undefined;
      const items = (contents ?? []).map(parseShelfItem).filter(Boolean) as ParsedItem[];
      out.push({ title, items });
      continue;
    }
    const shelf = nav(section, ["musicShelfRenderer"]) ?? nav(section, ["musicPlaylistShelfRenderer"]);
    if (shelf) {
      const title = textRun(nav(shelf, ["title"]));
      const contents = nav(shelf, ["contents"]) as unknown[] | undefined;
      const items = (contents ?? []).map(parseShelfItem).filter(Boolean) as ParsedItem[];
      out.push({ title, items });
      continue;
    }
    const grid = nav(section, ["gridRenderer"]);
    if (grid) {
      const title = textRun(nav(grid, ["header", "gridHeaderRenderer", "title"]));
      const items = (nav(grid, ["items"]) as unknown[] | undefined ?? []).map(parseShelfItem).filter(Boolean) as ParsedItem[];
      out.push({ title, items });
    }
  }
  return out;
}
