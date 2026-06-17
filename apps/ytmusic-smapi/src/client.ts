import { createContext, Script } from "node:vm";
import { Innertube, Log, Platform } from "youtubei.js";
import { getCookieString } from "./cookieAuth.js";

// Silence non-fatal parser warnings (TicketEvent submenu types YT keeps adding).
// Real failures still throw and reach our endpoint handlers.
Log.setLevel(Log.Level.NONE);

// youtubei.js v17 no longer ships a default JS evaluator for player decipher.
// Wire one up using Node's vm module so signature deciphering works.
const evalContext = createContext({});
Platform.load({
  ...Platform.shim,
  eval: (data: { output: string }) => {
    const script = new Script(`(function() {\n${data.output}\n})()`);
    return script.runInContext(evalContext, { timeout: 5000 });
  }
});

export interface YtmSearchTrack {
  videoId: string;
  title: string;
  artist?: string;
  album?: string;
  durationSeconds?: number;
  thumbnailUrl?: string;
}

export interface YtmStreamInfo {
  url: string;
  mimeType?: string;
}

let client: Innertube | undefined;
let initPromise: Promise<Innertube> | null = null;

export async function getClient(): Promise<Innertube> {
  if (client) return client;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    // Always run anonymously — restored OAuth sessions cause player/next calls
    // to 400, and we don't currently use auth for browse anyway.
    const yt = await Innertube.create({ retrieve_player: true });
    client = yt;
    return yt;
  })().finally(() => { initPromise = null; });
  return initPromise;
}

let authedClient: Innertube | undefined;
let authedCookieKey: string | undefined;

// A youtubei.js client carrying the pasted cookies, rebuilt if the cookie changes.
// Used only as a stream fallback for signed-in-only content (podcast episodes).
async function getAuthedClient(): Promise<Innertube | null> {
  const cookie = getCookieString();
  if (!cookie) return null;
  if (authedClient && authedCookieKey === cookie) return authedClient;
  try {
    authedClient = await Innertube.create({ retrieve_player: true, cookie });
    authedCookieKey = cookie;
    return authedClient;
  } catch (error) {
    console.warn(`[ytmusic] failed to build authed client: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

interface RawSongResult {
  id?: string;
  title?: string | { text?: string };
  artists?: { name?: string }[];
  album?: { name?: string } | string;
  duration?: { seconds?: number; text?: string };
  thumbnails?: { url: string }[];
  thumbnail?: { contents?: { url: string }[] };
}

export async function searchSongs(query: string, limit = 30): Promise<YtmSearchTrack[]> {
  const yt = await getClient();
  const music = yt.music;
  const results = await music.search(query, { type: "song" });
  const items: RawSongResult[] = readArray(results, ["contents", "items", "songs"]);
  return items
    .map(normalizeSong)
    .filter((item): item is YtmSearchTrack => item !== null)
    .slice(0, limit);
}

export async function getStreamUrl(videoId: string): Promise<YtmStreamInfo> {
  // The default WEB client requires a Proof-of-Origin token before googlevideo will
  // serve audio. Try alternate clients that historically don't need PO tokens, and
  // validate each candidate URL with a HEAD request before returning it.
  const anon = await getClient();
  const fromAnon = await resolveStream(anon, videoId, "anon");
  if (fromAnon.url) return { url: fromAnon.url, mimeType: fromAnon.mimeType };

  // Podcast episodes (and some gated tracks) only resolve for a signed-in session,
  // so retry with an authenticated client built from the pasted cookies.
  const authed = await getAuthedClient();
  if (authed) {
    const fromAuthed = await resolveStream(authed, videoId, "authed");
    if (fromAuthed.url) return { url: fromAuthed.url, mimeType: fromAuthed.mimeType };
    if (fromAuthed.error) throw fromAuthed.error;
  }
  throw fromAnon.error ?? new Error("All stream clients failed");
}

// Innertube player clients that historically serve audio without a PO token,
// ordered by what currently works (the gated TV_* clients sit at the back). YouTube
// rotates which clients it gates, so we also remember the last client that produced
// a playable URL and try it first — that keeps the common case to a single attempt
// (~1s) instead of burning seconds failing over gated clients, which can stall
// Sonos's stream start past its timeout.
const STREAM_CLIENTS = ["ANDROID_VR", "IOS", "TV_EMBEDDED", "TV_SIMPLY", "ANDROID", "WEB_EMBEDDED"] as const;
type StreamClient = (typeof STREAM_CLIENTS)[number];
let lastGoodClient: StreamClient | undefined;

async function resolveStream(yt: Innertube, videoId: string, label: string): Promise<{ url?: string; mimeType?: string; error?: Error }> {
  // Sticky client first (if any), then the rest — deduped.
  const order = [lastGoodClient, ...STREAM_CLIENTS].filter(
    (client, index, all): client is StreamClient => !!client && all.indexOf(client) === index
  );
  let lastError: Error | undefined;
  for (const client of order) {
    try {
      const info = await yt.getInfo(videoId, { client });
      const format = info.chooseFormat({ type: "audio", quality: "best" });
      if (!format) continue;
      const decipheredUrl = await format.decipher(yt.session.player);
      if (await urlIsPlayable(decipheredUrl)) {
        if (lastGoodClient !== client) console.log(`[ytmusic] using client=${client} (${label})`);
        lastGoodClient = client;
        return { url: decipheredUrl, mimeType: format.mime_type ?? "audio/mp4" };
      }
      console.log(`[ytmusic] client=${client} (${label}) returned URL that failed HEAD`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.log(`[ytmusic] client=${client} (${label}) errored: ${lastError.message}`);
    }
  }
  // The sticky client just failed end-to-end — clear it so the next call re-probes.
  lastGoodClient = undefined;
  return { error: lastError };
}

async function urlIsPlayable(url: string): Promise<boolean> {
  const controller = new AbortController();
  // Bound the worst case: a gated client whose URL hangs shouldn't add 5s to the
  // time-to-first-byte that Sonos is waiting on.
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(url, {
      method: "HEAD",
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        accept: "*/*",
        origin: "https://music.youtube.com",
        referer: "https://music.youtube.com/"
      },
      signal: controller.signal
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function getTrackMetadata(videoId: string): Promise<YtmSearchTrack | null> {
  const yt = await getClient();
  const info = await yt.music.getInfo(videoId);
  const basic = info.basic_info;
  if (!basic) return null;
  return {
    videoId,
    title: basic.title ?? "Unknown",
    artist: basic.author ?? undefined,
    album: undefined,
    durationSeconds: basic.duration ?? undefined,
    thumbnailUrl: pickBestThumbnail(basic.thumbnail)
  };
}

function normalizeSong(item: RawSongResult | unknown): YtmSearchTrack | null {
  if (!item || typeof item !== "object") return null;
  const record = item as RawSongResult;
  const videoId = record.id ?? extractId(record);
  if (!videoId) return null;
  const title = typeof record.title === "string" ? record.title : record.title?.text ?? "Unknown";
  const artist = record.artists?.[0]?.name;
  const album = typeof record.album === "string" ? record.album : record.album?.name;
  const durationSeconds = record.duration?.seconds ?? parseDuration(record.duration?.text);
  return {
    videoId,
    title,
    artist,
    album,
    durationSeconds,
    thumbnailUrl: pickBestThumbnail(record.thumbnails ?? record.thumbnail?.contents)
  };
}

function readArray(root: unknown, keys: string[]): RawSongResult[] {
  const queue: unknown[] = [root];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || typeof node !== "object") continue;
    const obj = node as Record<string, unknown>;
    for (const key of keys) {
      const value = obj[key];
      if (Array.isArray(value) && value.length > 0 && hasIdLike(value[0])) return value as RawSongResult[];
    }
    for (const value of Object.values(obj)) {
      if (value && typeof value === "object") queue.push(value);
    }
  }
  return [];
}

function hasIdLike(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" || record.video_id !== undefined || typeof record.videoId === "string";
}

function extractId(record: RawSongResult): string | undefined {
  const generic = record as Record<string, unknown>;
  const value = generic.videoId ?? generic.video_id;
  return typeof value === "string" ? value : undefined;
}

function parseDuration(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const parts = text.split(":").map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => Number.isNaN(part))) return undefined;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

function pickBestThumbnail(thumbs: unknown): string | undefined {
  if (!Array.isArray(thumbs)) return undefined;
  let best: { url: string; width?: number } | undefined;
  for (const candidate of thumbs) {
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as { url?: string; width?: number };
    if (typeof record.url !== "string") continue;
    if (!best || (record.width ?? 0) > (best.width ?? 0)) best = { url: record.url, width: record.width };
  }
  return best?.url;
}
