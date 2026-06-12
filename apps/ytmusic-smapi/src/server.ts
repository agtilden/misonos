import http from "node:http";
import type { SourceBrowseItem, SourceBrowseResponse, SourceTrackInfo } from "@misonos/sonos-protocol";
import type { YtmConfig } from "./config.js";
import { getStreamUrl, getTrackMetadata, searchSongs } from "./client.js";
import { decodeId, encodeId } from "./ids.js";

export function createServer(config: YtmConfig): http.Server {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, { ok: true, service: config.serviceName });
      }
      if (request.method === "GET" && url.pathname === "/info") {
        return sendJson(response, 200, {
          id: "youtube-music",
          name: config.serviceName,
          description: "YouTube Music search and playback (anonymous)",
          rootId: encodeId({ kind: "root" }),
          capabilities: ["search"]
        });
      }
      if (request.method === "GET" && url.pathname === "/browse") {
        const rawId = url.searchParams.get("id") ?? encodeId({ kind: "root" });
        return sendJson(response, 200, await browse(rawId));
      }
      if (request.method === "GET" && url.pathname === "/search") {
        const query = url.searchParams.get("q") ?? "";
        if (!query) return sendJson(response, 400, { error: "Missing q" });
        return sendJson(response, 200, await runSearch(query));
      }
      if (request.method === "GET" && url.pathname === "/track") {
        const rawId = url.searchParams.get("id");
        if (!rawId) return sendJson(response, 400, { error: "Missing id" });
        return sendJson(response, 200, await resolveTrack(rawId));
      }
      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      const status = error instanceof Error && error.message.startsWith("Bad ") ? 400 : 500;
      sendJson(response, status, { error: error instanceof Error ? error.message : "Internal error" });
    }
  });
}

async function browse(rawId: string): Promise<SourceBrowseResponse> {
  const id = decodeId(rawId);
  if (id.kind === "root") {
    const items: SourceBrowseItem[] = [
      {
        id: encodeId({ kind: "search", query: "" }),
        title: "Search YouTube Music",
        kind: "container",
        subtitle: "Use the search box above to find tracks"
      }
    ];
    return { id: rawId, title: "YouTube Music", total: items.length, items };
  }
  if (id.kind === "search") {
    if (!id.query) return { id: rawId, title: "Search", total: 0, items: [] };
    const response = await runSearch(id.query);
    return { ...response, id: rawId };
  }
  throw new Error("Bad id for browse");
}

async function runSearch(query: string): Promise<SourceBrowseResponse> {
  const songs = await searchSongs(query);
  const items: SourceBrowseItem[] = songs.map((song) => ({
    id: encodeId({ kind: "track", videoId: song.videoId }),
    title: song.title,
    kind: "playable",
    artist: song.artist,
    album: song.album,
    subtitle: [song.artist, song.album].filter(Boolean).join(" · ") || undefined,
    durationSeconds: song.durationSeconds
  }));
  return {
    id: encodeId({ kind: "search", query }),
    title: `“${query}”`,
    total: items.length,
    items
  };
}

async function resolveTrack(rawId: string): Promise<SourceTrackInfo> {
  const id = decodeId(rawId);
  if (id.kind !== "track") throw new Error("Bad id for track");
  const [meta, stream] = await Promise.all([
    getTrackMetadata(id.videoId).catch(() => null),
    getStreamUrl(id.videoId)
  ]);
  return {
    id: rawId,
    title: meta?.title ?? id.videoId,
    artist: meta?.artist,
    album: meta?.album,
    durationSeconds: meta?.durationSeconds,
    url: stream.url,
    mimeType: stream.mimeType ?? "audio/mp4"
  };
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
