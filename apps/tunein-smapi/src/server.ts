import http from "node:http";
import type { SourceTrackInfo } from "@misonos/sonos-protocol";
import type { TuneInConfig } from "./config.js";
import { decodeId, encodeId } from "./ids.js";
import { browseGuide, browseRoot, searchResults } from "./browse.js";
import { tune } from "./tunein.js";
import { FavoritesStore } from "./store.js";

export function createServer(config: TuneInConfig): http.Server {
  const store = new FavoritesStore(config.dbPath);

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, { ok: true, service: config.serviceName });
      }
      if (request.method === "GET" && url.pathname === "/info") {
        return sendJson(response, 200, {
          id: "tunein",
          name: config.serviceName,
          description: "Internet radio via the TuneIn directory",
          rootId: encodeId({ kind: "root" }),
          capabilities: ["search", "pin"]
        });
      }
      if (request.method === "GET" && url.pathname === "/browse") {
        const rawId = url.searchParams.get("id") ?? encodeId({ kind: "root" });
        const items = await browseId(config, rawId, store);
        return sendJson(response, 200, { id: rawId, total: items.length, items });
      }
      if (request.method === "GET" && url.pathname === "/search") {
        const query = url.searchParams.get("q") ?? "";
        if (!query.trim()) return sendJson(response, 400, { error: "Missing q" });
        const items = await searchResults(config, query.trim());
        return sendJson(response, 200, { id: `search:${query}`, title: `“${query}”`, total: items.length, items });
      }
      if (request.method === "GET" && url.pathname === "/track") {
        const rawId = url.searchParams.get("id");
        if (!rawId) return sendJson(response, 400, { error: "Missing id" });
        return sendJson(response, 200, await trackInfo(config, rawId));
      }
      if (request.method === "GET" && url.pathname === "/subscriptions") {
        // Return encoded station ids so the web can match them against browse-item
        // ids — built field-for-field like browse.ts so the tokens are byte-identical.
        return sendJson(response, 200, {
          ids: store.list().map((fav) =>
            encodeId({ kind: "station", guideId: fav.guideId, name: fav.name, image: fav.image, subtext: fav.subtext })
          )
        });
      }
      if (request.method === "POST" && (url.pathname === "/pin" || url.pathname === "/unpin")) {
        const body = await readJson(request);
        const id = typeof body.id === "string" ? body.id : undefined;
        if (!id) return sendJson(response, 400, { error: "Missing id" });
        const decoded = decodeId(id);
        if (decoded.kind !== "station") return sendJson(response, 400, { error: "Not a station id" });
        if (url.pathname === "/unpin") {
          store.remove(decoded.guideId);
          return sendJson(response, 200, { pinned: false });
        }
        store.add({ guideId: decoded.guideId, name: decoded.name, image: decoded.image, subtext: decoded.subtext });
        return sendJson(response, 200, { pinned: true });
      }

      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "Internal error" });
    }
  });
}

async function browseId(config: TuneInConfig, rawId: string, store: FavoritesStore) {
  const id = decodeId(rawId);
  switch (id.kind) {
    case "root":
    case "favorites":
      return browseRoot(config, store);
    case "guide":
      return browseGuide(config, id.url);
    case "station":
      throw new Error("Stations are leaves");
  }
}

async function trackInfo(config: TuneInConfig, rawId: string): Promise<SourceTrackInfo> {
  const id = decodeId(rawId);
  if (id.kind !== "station") throw new Error("Not a station id");
  const streams = await tune(config, id.guideId);
  const stream = streams[0];
  if (!stream) throw new Error("Station has no playable stream");
  return {
    // Live radio is a single endless "track": title is the station, the subtext
    // (e.g. "New York Public Radio") is the only useful secondary line. Leaving
    // artist/album empty avoids echoing the station name back as its own subtitle.
    id: rawId,
    title: id.name,
    artist: id.subtext,
    albumArtUri: id.image,
    url: stream.url,
    mimeType: mimeFor(stream.mediaType),
    isLive: true
  };
}

function mimeFor(mediaType: string | undefined): string {
  switch ((mediaType ?? "").toLowerCase()) {
    case "aac": return "audio/aac";
    case "ogg": return "audio/ogg";
    case "hls": return "application/vnd.apple.mpegurl";
    case "mp3":
    default: return "audio/mpeg";
  }
}

async function readJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
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
