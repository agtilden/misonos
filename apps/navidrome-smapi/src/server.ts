import http from "node:http";
import { Readable } from "node:stream";
import { NavidromeBrowser } from "./browse.js";
import { serverFromConfig, type NavidromeConfig } from "./config.js";
import { encodeId } from "./ids.js";
import { planStream } from "./stream.js";
import { SubsonicClient, type SubsonicSong } from "./subsonic.js";

const SONG_CACHE_TTL_MS = 10 * 60 * 1000;
const SONG_CACHE_MAX = 500;
const PASSTHROUGH_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag"];

export function createServer(config: NavidromeConfig): http.Server {
  const server = serverFromConfig(config);
  const api = server ? new SubsonicClient(server) : undefined;
  const browser = api ? new NavidromeBrowser(api, config) : undefined;
  // Sonos issues several requests per track (HEAD, ranges); resolve each song once.
  const songs = new Map<string, { song: SubsonicSong; expires: number }>();

  const lookupSong = async (client: SubsonicClient, id: string): Promise<SubsonicSong> => {
    const now = Date.now();
    const hit = songs.get(id);
    if (hit && hit.expires > now) return hit.song;
    const song = await client.song(id);
    if (songs.size >= SONG_CACHE_MAX) songs.clear();
    songs.set(id, { song, expires: now + SONG_CACHE_TTL_MS });
    return song;
  };

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      const base = config.publicUrl ?? url.origin;

      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, { ok: true, service: config.serviceName, configured: Boolean(api) });
      }
      // Unconfigured, the bridge's /info probe fails and the source stays hidden.
      if (!api || !browser) {
        return sendJson(response, 503, {
          error: "Navidrome is not configured: set MISONOS_NAVIDROME_SERVER_URL, MISONOS_NAVIDROME_USER and MISONOS_NAVIDROME_PASSWORD"
        });
      }
      if (request.method === "GET" && url.pathname === "/info") {
        return sendJson(response, 200, {
          id: "navidrome",
          name: config.serviceName,
          description: "Your music library on Navidrome",
          rootId: encodeId({ kind: "root" }),
          capabilities: ["search"]
        });
      }
      if (request.method === "GET" && url.pathname === "/browse") {
        const id = url.searchParams.get("id") ?? encodeId({ kind: "root" });
        try {
          return sendJson(response, 200, await browser.browse(id, base));
        } catch (error) {
          return sendJson(response, 400, { error: errorMessage(error) });
        }
      }
      if (request.method === "GET" && url.pathname === "/search") {
        const query = (url.searchParams.get("q") ?? "").trim();
        if (!query) return sendJson(response, 400, { error: "Missing q" });
        return sendJson(response, 200, await browser.search(query, base));
      }
      if (request.method === "GET" && url.pathname === "/track") {
        const id = url.searchParams.get("id");
        if (!id) return sendJson(response, 400, { error: "Missing id" });
        try {
          return sendJson(response, 200, await browser.track(id, base));
        } catch (error) {
          return sendJson(response, 502, { error: errorMessage(error) });
        }
      }
      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/stream") {
        const id = url.searchParams.get("id");
        if (!id) return sendJson(response, 400, { error: "Missing id" });
        const song = await lookupSong(api, id);
        const plan = planStream(song, config, request.headers.range);
        const headers: Record<string, string> = {};
        if (plan.forwardRange && request.headers.range) headers.range = request.headers.range;
        return relay(request, response, api.url("stream", plan.params), headers, (out) => {
          if (!plan.partial) return 200;
          delete out["content-length"];
          out["content-range"] = `bytes ${plan.partial.start}-${plan.partial.total - 1}/${plan.partial.total}`;
          return 206;
        });
      }
      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/art") {
        const id = url.searchParams.get("id");
        if (!id) return sendJson(response, 400, { error: "Missing id" });
        const size = url.searchParams.get("size") ?? undefined;
        return relay(request, response, api.url("getCoverArt", { id, size }), {}, (out) => {
          out["cache-control"] = "public, max-age=86400";
          return undefined;
        });
      }
      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendJson(response, 502, { error: errorMessage(error) });
    }
  });
}

// Pipe a Subsonic binary endpoint (stream / cover art) to the client. `adjust` may
// rewrite the outgoing headers and return a status override.
async function relay(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  upstreamUrl: URL,
  headers: Record<string, string>,
  adjust: (out: Record<string, string>) => number | undefined
): Promise<void> {
  const controller = new AbortController();
  response.on("close", () => controller.abort());
  const upstream = await fetch(upstreamUrl, {
    method: request.method === "HEAD" ? "HEAD" : "GET",
    headers,
    signal: controller.signal
  });
  const contentType = upstream.headers.get("content-type") ?? "";
  // Subsonic reports errors (bad id, auth) as a JSON/XML body, not an HTTP status.
  if (!upstream.ok || /json|xml/i.test(contentType)) {
    const detail = /json/i.test(contentType) ? subsonicError(await upstream.text()) : `HTTP ${upstream.status}`;
    return sendJson(response, upstream.ok ? 502 : upstream.status, { error: `Navidrome: ${detail}` });
  }
  const out: Record<string, string> = {};
  for (const name of PASSTHROUGH_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) out[name] = value;
  }
  const status = adjust(out) ?? upstream.status;
  response.writeHead(status, out);
  if (request.method === "HEAD" || !upstream.body) {
    response.end();
    return;
  }
  const body = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
  body.on("error", () => response.destroy());
  body.pipe(response);
}

function subsonicError(text: string): string {
  try {
    const body = JSON.parse(text) as { "subsonic-response"?: { error?: { message?: string } } };
    return body["subsonic-response"]?.error?.message ?? "request failed";
  } catch {
    return "request failed";
  }
}

function sendJson(response: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Internal error";
}
