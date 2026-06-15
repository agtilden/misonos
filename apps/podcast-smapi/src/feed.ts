import { lookup } from "node:dns/promises";
import net from "node:net";
import { XMLParser } from "fast-xml-parser";

export interface PodcastEpisode {
  guid: string;
  title: string;
  enclosureUrl: string;
  enclosureType?: string;
  durationSeconds?: number;
  pubDateMs?: number;
  image?: string;
}

export interface PodcastFeed {
  feedUrl: string;
  title: string;
  author?: string;
  description?: string;
  image?: string;
  episodes: PodcastEpisode[];
}

const FETCH_TIMEOUT_MS = 12000;
const MAX_FEED_BYTES = 12 * 1024 * 1024;
const CACHE_TTL_MS = 15 * 60 * 1000;
const USER_AGENT = "MiSonos-Podcasts/0.1 (+https://github.com/agtilden/misonos)";

interface CacheEntry { feed: PodcastFeed; fetchedAt: number; etag?: string; lastModified?: string }
const cache = new Map<string, CacheEntry>();

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Keep <item> as an array even when a feed has a single episode.
  isArray: (name) => name === "item"
});

// SSRF guard: require http(s) and reject any URL whose host resolves to a private,
// loopback, or link-local address (blocks forged ids targeting host/LAN services).
async function assertPublicUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid feed URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Unsupported feed URL scheme");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(host) ? [host] : (await lookup(host, { all: true })).map((entry) => entry.address);
  if (addresses.length === 0) throw new Error("Feed host did not resolve");
  for (const address of addresses) {
    if (isPrivateAddress(address)) throw new Error("Feed host is not allowed");
  }
}

export function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;        // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (net.isIPv6(address)) {
    const h = ipv6Hextets(address);
    if (!h) return true; // unparseable → reject
    // IPv4-mapped (::ffff:a.b.c.d, in dotted OR hex form) — classify the embedded v4.
    if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) {
      return isPrivateAddress(`${h[6] >> 8}.${h[6] & 0xff}.${h[7] >> 8}.${h[7] & 0xff}`);
    }
    const allButLastZero = h.slice(0, 7).every((x) => x === 0);
    if (allButLastZero && (h[7] === 0 || h[7] === 1)) return true; // :: and ::1
    if ((h[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
    if ((h[0] & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7
    return false;
  }
  return true; // unknown format → reject
}

// Expand an IPv6 literal (incl. "::" compression and a trailing dotted IPv4) into
// its 8 16-bit groups, so mapped/loopback/link-local forms can be classified by value
// rather than by string prefix.
function ipv6Hextets(input: string): number[] | null {
  let address = input.toLowerCase().split("%")[0];
  // Fold a trailing dotted IPv4 (e.g. ::ffff:127.0.0.1) into two hextets.
  const dotted = address.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const o = dotted.slice(1).map(Number);
    if (o.some((n) => n > 255)) return null;
    address = address.slice(0, dotted.index) + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
  } else if (head.length + tail.length > 7) {
    return null;
  }
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array(fill).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  return groups.map((g) => Number.parseInt(g || "0", 16));
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

// Fetch with manual redirect handling so the SSRF guard is re-applied to EVERY hop —
// a public URL that 30x-redirects to a private/LAN host is rejected at the redirect.
async function fetchValidating(startUrl: string, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(current);
    const response = await fetch(current, { headers, redirect: "manual", signal });
    if (!REDIRECT_STATUS.has(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    current = new URL(location, current).toString();
  }
  throw new Error("Too many redirects");
}

// Fetch + parse an RSS feed, caching by URL with conditional requests so repeated
// "New Episodes" scans are cheap.
export async function getFeed(feedUrl: string, force = false): Promise<PodcastFeed> {
  const cached = cache.get(feedUrl);
  if (!force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.feed;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { "User-Agent": USER_AGENT, Accept: "application/rss+xml,application/xml,text/xml,*/*" };
    if (cached?.etag) headers["If-None-Match"] = cached.etag;
    if (cached?.lastModified) headers["If-Modified-Since"] = cached.lastModified;

    const response = await fetchValidating(feedUrl, headers, controller.signal);
    if (response.status === 304 && cached) {
      cached.fetchedAt = Date.now();
      return cached.feed;
    }
    if (!response.ok) throw new Error(`Feed ${response.status}`);
    const xml = await readCapped(response);
    const feed = parseFeed(feedUrl, xml);
    cache.set(feedUrl, {
      feed,
      fetchedAt: Date.now(),
      etag: response.headers.get("etag") ?? undefined,
      lastModified: response.headers.get("last-modified") ?? undefined
    });
    return feed;
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_FEED_BYTES) throw new Error("Feed too large");
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.length > MAX_FEED_BYTES) throw new Error("Feed too large");
  return buf.toString("utf8");
}

type AnyRec = Record<string, unknown>;

export function parseFeed(feedUrl: string, xml: string): PodcastFeed {
  const root = parser.parse(xml) as AnyRec;
  const channel = (root.rss as AnyRec | undefined)?.channel as AnyRec | undefined
    ?? (root.feed as AnyRec | undefined); // tolerate Atom-ish roots
  if (!channel) throw new Error("Not an RSS feed");

  const channelImage = pickImage(channel);
  const items = (channel.item as AnyRec[] | undefined) ?? [];
  const episodes: PodcastEpisode[] = [];
  for (const item of items) {
    const enclosure = item.enclosure as AnyRec | undefined;
    const enclosureUrl = typeof enclosure?.["@_url"] === "string" ? enclosure["@_url"] as string : undefined;
    if (!enclosureUrl) continue; // not playable
    const title = text(item.title) ?? "Untitled episode";
    episodes.push({
      guid: guidOf(item) ?? enclosureUrl,
      title,
      enclosureUrl,
      enclosureType: typeof enclosure?.["@_type"] === "string" ? enclosure["@_type"] as string : undefined,
      durationSeconds: parseDuration(text(item["itunes:duration"])),
      pubDateMs: parseDate(text(item.pubDate)),
      image: pickImage(item) ?? channelImage
    });
  }

  return {
    feedUrl,
    title: text(channel.title) ?? "Podcast",
    author: text(channel["itunes:author"]) ?? text((channel.author as AnyRec | undefined)) ?? undefined,
    description: text(channel.description),
    image: channelImage,
    episodes
  };
}

function guidOf(item: AnyRec): string | undefined {
  const guid = item.guid;
  if (typeof guid === "string") return guid;
  if (guid && typeof guid === "object") return text((guid as AnyRec)["#text"]);
  return text(item.link);
}

function pickImage(node: AnyRec): string | undefined {
  const itunesImage = node["itunes:image"] as AnyRec | string | undefined;
  if (itunesImage && typeof itunesImage === "object" && typeof itunesImage["@_href"] === "string") return itunesImage["@_href"] as string;
  const image = node.image as AnyRec | string | undefined;
  if (image && typeof image === "object" && typeof image.url === "string") return image.url as string;
  if (typeof image === "string") return image;
  return undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object" && "#text" in (value as AnyRec)) return text((value as AnyRec)["#text"]);
  return undefined;
}

function parseDuration(value: string | undefined): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number.parseInt(value, 10);
  const parts = value.split(":").map((p) => Number.parseInt(p, 10));
  if (parts.some((p) => Number.isNaN(p))) return undefined;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

function parseDate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}
