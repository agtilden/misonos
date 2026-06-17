import type { TuneInConfig } from "./config.js";

// TuneIn's OPML/RadioTime directory API. We request `render=json` so every call
// returns a `{ head, body }` document instead of OPML XML — no XML parsing needed.
// All directory traffic targets this one host; the only URLs we follow are the
// Browse.ashx links TuneIn itself hands back (re-validated against ALLOWED_HOSTS),
// so a forged guide id can't redirect our fetches off-network.
const BASE = "https://opml.radiotime.com";
const ALLOWED_HOSTS = new Set(["opml.radiotime.com", "feed.tunein.com", "api.tunein.com"]);
const USER_AGENT = "MiSonos-TuneIn/0.1 (+https://github.com/agtilden/misonos)";
const TIMEOUT_MS = 10000;

// A single OPML outline node. Containers carry `type:"link"`, stations carry
// `type:"audio"`; bare group headers have no `type` but do have `children`.
export interface Outline {
  element?: string;
  type?: "link" | "audio" | "text";
  text?: string;
  URL?: string;
  key?: string;
  guide_id?: string;
  image?: string;
  subtext?: string;
  item?: string;
  bitrate?: string;
  formats?: string;
  children?: Outline[];
}

// A single playable stream returned by Tune.ashx.
export interface TuneStream {
  url: string;
  mediaType?: string;
  bitrate?: number;
  reliability?: number;
  isDirect?: boolean;
}

interface OpmlDoc {
  head?: { status?: string; title?: string };
  body?: Outline[];
}

function withParams(target: URL, config: TuneInConfig): URL {
  target.searchParams.set("render", "json");
  if (config.partnerId) target.searchParams.set("partnerId", config.partnerId);
  if (config.serial) target.searchParams.set("serial", config.serial);
  return target;
}

async function getJson(target: URL): Promise<OpmlDoc> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(target, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json,*/*" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`TuneIn ${response.status}`);
    return (await response.json()) as OpmlDoc;
  } finally {
    clearTimeout(timer);
  }
}

// Fetch the directory root (Local Radio / Music / Talk / Sports / ...).
export async function browseRoot(config: TuneInConfig): Promise<Outline[]> {
  const doc = await getJson(withParams(new URL("/Browse.ashx", BASE), config));
  return doc.body ?? [];
}

// Follow one of TuneIn's own Browse.ashx links. The host is re-validated so a
// forged/base64-decoded id can't point the fetch at an arbitrary server.
export async function browseUrl(config: TuneInConfig, rawUrl: string): Promise<Outline[]> {
  const target = new URL(rawUrl);
  if (!ALLOWED_HOSTS.has(target.hostname)) throw new Error(`Disallowed TuneIn host: ${target.hostname}`);
  const doc = await getJson(withParams(target, config));
  return doc.body ?? [];
}

export async function search(config: TuneInConfig, query: string): Promise<Outline[]> {
  const target = withParams(new URL("/Search.ashx", BASE), config);
  target.searchParams.set("query", query);
  const doc = await getJson(target);
  return doc.body ?? [];
}

// Resolve a station guide_id to its playable streams, best (most reliable, then
// highest bitrate) first. Prefers direct streams; non-direct entries (playlist
// wrappers like .pls/.m3u) sort last but are still returned as a fallback.
export async function tune(config: TuneInConfig, guideId: string): Promise<TuneStream[]> {
  const target = withParams(new URL("/Tune.ashx", BASE), config);
  target.searchParams.set("id", guideId);
  const doc = await getJson(target);
  const streams: TuneStream[] = [];
  for (const entry of doc.body ?? []) {
    const url = (entry as Record<string, unknown>).url;
    if (typeof url !== "string" || !url) continue;
    const rec = entry as Record<string, unknown>;
    streams.push({
      url,
      mediaType: typeof rec.media_type === "string" ? rec.media_type : undefined,
      bitrate: typeof rec.bitrate === "number" ? rec.bitrate : Number(rec.bitrate) || undefined,
      reliability: typeof rec.reliability === "number" ? rec.reliability : Number(rec.reliability) || undefined,
      isDirect: rec.is_direct === true || rec.is_direct === "true"
    });
  }
  streams.sort((a, b) => {
    if (!!b.isDirect !== !!a.isDirect) return b.isDirect ? 1 : -1;
    return (b.reliability ?? 0) - (a.reliability ?? 0) || (b.bitrate ?? 0) - (a.bitrate ?? 0);
  });
  return streams;
}
